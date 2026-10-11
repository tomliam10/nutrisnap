// NutriSnap API: holds the AI key, applies usage limits, forwards the photo to Gemini or Claude.
const SYSTEM = `You are a registered-dietitian-grade food analyst. Given a photo of food or a drink:
1. Identify the dish (be specific, e.g. "Chicken pad thai", not "noodles").
2. Dissect it into its individual ingredients, including hidden ones that are very likely present (cooking oil, sauces, dressings, butter, sugar).
3. Estimate the cooked/served weight in grams of EACH ingredient from visual cues (plate size, utensils, portion depth, typical serving sizes).
4. For each ingredient give calories (kcal), protein, carbohydrate and fat in grams for that weight, using standard USDA-style nutrition values.
Be realistic, not optimistic: restaurant portions are usually larger and oilier than home cooking. If the image contains no edible food or drink, set is_food=false and return an empty ingredient list.`;

const ING = {
  name: { type: 'string' }, weight_g: { type: 'number' }, calories: { type: 'number' },
  protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' }, visible: { type: 'boolean' },
};
const PROPS = {
  is_food: { type: 'boolean' }, dish_name: { type: 'string' }, cuisine: { type: 'string' },
  confidence: { type: 'number' }, serving_description: { type: 'string' }, notes: { type: 'string' },
  ingredients: { type: 'array', items: { type: 'object', required: ['name', 'weight_g', 'calories', 'protein_g', 'carbs_g', 'fat_g'], properties: ING } },
};
const REQUIRED = ['is_food', 'dish_name', 'confidence', 'ingredients'];
const upper = (s) => JSON.parse(JSON.stringify(s), (k, v) => (k === 'type' && typeof v === 'string' ? v.toUpperCase() : v));

const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_B64 = 7 * 1024 * 1024; // ~5 MB image

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-device-id',
      Vary: 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/analyze') return json({ error: 'Not found' }, 404);
    if (!allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
    const { image, mediaType, note } = body || {};
    if (typeof image !== 'string' || image.length > MAX_B64 || !TYPES.has(mediaType)) return json({ error: 'Send a JPEG/PNG/WebP photo under 5 MB.' }, 400);

    // ---- usage limits (KV counters per day) ----
    const day = new Date().toISOString().slice(0, 10);
    const device = (req.headers.get('x-device-id') || 'none').slice(0, 64);
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    if (env.LIMITS) {
      const checks = [
        [`d:${device}:${day}`, +env.DEVICE_DAILY_LIMIT, 'You have used all of today\'s free scans. Come back tomorrow!'],
        [`i:${ip}:${day}`, +env.IP_DAILY_LIMIT, 'Too many scans from this network today. Try again tomorrow.'],
        [`g:${day}`, +env.GLOBAL_DAILY_LIMIT, 'NutriSnap is at capacity for today. Please try again tomorrow.'],
      ];
      const counts = await Promise.all(checks.map(([k]) => env.LIMITS.get(k)));
      for (let i = 0; i < checks.length; i++) if ((+counts[i] || 0) >= checks[i][1]) return json({ error: checks[i][2] }, 429);
      await Promise.all(checks.map(([k], i) => env.LIMITS.put(k, String((+counts[i] || 0) + 1), { expirationTtl: 172800 })));
    }

    const userText = 'Analyze this meal.' + (note ? ` The user adds: "${String(note).slice(0, 300)}"` : '');
    try {
      const result = env.PROVIDER === 'claude' ? await askClaude(env, image, mediaType, userText) : await askGemini(env, image, mediaType, userText);
      return json(result);
    } catch (e) {
      console.error(e.message);
      return json({ error: 'The AI service had a problem. Please try again.' }, 502);
    }
  },
};

async function askGemini(env, image, mediaType, text) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mediaType, data: image } }, { text }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json',
        responseSchema: upper({ type: 'object', required: REQUIRED, properties: PROPS }) },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${data?.error?.message || ''}`);
  const out = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  if (!out) throw new Error('Gemini returned no content');
  return JSON.parse(out);
}

async function askClaude(env, image, mediaType, text) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL, max_tokens: 2500, system: SYSTEM,
      tools: [{ name: 'report_meal', description: 'Report the meal analysis.', input_schema: { type: 'object', required: REQUIRED, properties: PROPS } }],
      tool_choice: { type: 'tool', name: 'report_meal' },
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: image } }, { type: 'text', text }] }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Claude ${r.status}: ${data?.error?.message || ''}`);
  const block = (data.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new Error('Claude returned no tool call');
  return block.input;
}

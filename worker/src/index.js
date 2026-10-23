// NutriSnap API: holds the AI key, applies usage limits, forwards the photo to Gemini or Claude.
const SYSTEM = `You are a registered-dietitian-grade food analyst. Given a photo of food or a drink, or a text description of what someone ate:
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
    const path = new URL(req.url).pathname;
    if (req.method !== 'POST' || path !== '/analyze') return json({ error: 'Not found' }, 404);
    if (!allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
    const { image, mediaType, note } = body || {};
    const hasImage = image !== undefined && image !== null;
    const text = typeof note === 'string' ? note.trim().slice(0, 400) : '';
    if (hasImage ? (typeof image !== 'string' || image.length > MAX_B64 || !TYPES.has(mediaType)) : text.length < 3) {
      return json({ error: hasImage ? 'Send a JPEG/PNG/WebP photo under 5 MB.' : 'Take a photo or describe what you ate.' }, 400);
    }

    // ---- usage limits (KV counters per day) ----
    const day = new Date().toISOString().slice(0, 10);
    const device = (req.headers.get('x-device-id') || 'none').slice(0, 64);
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    let refund = async () => {};
    let quota = null;
    if (env.LIMITS) {
      const checks = [
        [`d:${device}:${day}`, +env.DEVICE_DAILY_LIMIT, 'You have used all of today\'s free scans. Come back tomorrow!'],
        [`i:${ip}:${day}`, +env.IP_DAILY_LIMIT, 'Too many scans from this network today. Try again tomorrow.'],
        [`g:${day}`, +env.GLOBAL_DAILY_LIMIT, 'NutriSnap is at capacity for today. Please try again tomorrow.'],
      ];
      const counts = await Promise.all(checks.map(([k]) => env.LIMITS.get(k)));
      for (let i = 0; i < checks.length; i++) if ((+counts[i] || 0) >= checks[i][1]) return json({ error: checks[i][2], quota: { left: 0, limit: +env.DEVICE_DAILY_LIMIT } }, 429);
      await Promise.all(checks.map(([k], i) => env.LIMITS.put(k, String((+counts[i] || 0) + 1), { expirationTtl: 172800 })));
      quota = { left: Math.max(0, +env.DEVICE_DAILY_LIMIT - ((+counts[0] || 0) + 1)), limit: +env.DEVICE_DAILY_LIMIT };
      // a failed scan should not use up someone's daily allowance
      refund = () => Promise.all(checks.map(([k], i) => env.LIMITS.put(k, String(+counts[i] || 0), { expirationTtl: 172800 }))).catch(() => {});
    }

    const userText = hasImage
      ? 'Analyze this meal.' + (text ? ` The user adds: "${text}"` : '')
      : `There is no photo. Estimate the nutrition of this meal as described by the user: "${text}". Use typical portion sizes where the amount is not stated, list each ingredient (including cooking oil or butter if likely), and state your portion assumptions in notes. Set is_food=false only if this is not something edible.`;
    const models = env.PROVIDER === 'claude' ? [env.CLAUDE_MODEL]
      : (env.GEMINI_MODELS || env.GEMINI_MODEL).split(',').map((m) => m.trim()).filter(Boolean);
    const ask = env.PROVIDER === 'claude' ? askClaude : askGemini;
    let detail = '', quotaHits = 0;
    for (const model of models) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { return json({ ...(await ask(env, model, hasImage ? image : null, mediaType, userText)), quota }); }
        catch (e) {
          detail = `${model} -> ${e?.name || 'Error'}: ${e?.message || String(e)}`.slice(0, 300);
          console.error(`attempt ${attempt} failed: ${detail}`);
          if (e?.status === 429) { quotaHits++; break; }  // out of quota: no point retrying this model
          if (e?.status === 404) break;                    // model retired: try the next one
        }
      }
    }
    await refund();
    const out = quota && { left: quota.left + 1, limit: quota.limit };
    if (quotaHits === models.length) return json({ error: "NutriSnap's free AI capacity is used up for today. Please try again tomorrow.", detail, quota: out }, 503);
    return json({ error: 'The AI service is busy right now. Please try again in a moment.', detail, quota: out }, 502);
  },
};

async function askGemini(env, model, image, mediaType, text) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [...(image ? [{ inline_data: { mime_type: mediaType, data: image } }] : []), { text }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json',
        responseSchema: upper({ type: 'object', required: REQUIRED, properties: PROPS }) },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Gemini HTTP ${r.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`), { status: r.status });
  const out = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  if (!out) throw new Error('Gemini returned no content');
  return JSON.parse(out);
}

async function askClaude(env, model, image, mediaType, text) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(25000),
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 2500, system: SYSTEM,
      tools: [{ name: 'report_meal', description: 'Report the meal analysis.', input_schema: { type: 'object', required: REQUIRED, properties: PROPS } }],
      tool_choice: { type: 'tool', name: 'report_meal' },
      messages: [{ role: 'user', content: [...(image ? [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: image } }] : []), { type: 'text', text }] }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Claude ${r.status}: ${data?.error?.message || ''}`), { status: r.status });
  const block = (data.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new Error('Claude returned no tool call');
  return block.input;
}

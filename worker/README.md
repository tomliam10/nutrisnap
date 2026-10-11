# NutriSnap API (Cloudflare Worker)

Holds the AI key so app users never need one. Limits scans per device/network/day.

1. `cd worker && npx wrangler login`            (opens a browser; approve)
2. `npx wrangler kv namespace create LIMITS`     (copy the printed id into wrangler.toml and uncomment the kv block)
3. `npx wrangler secret put GEMINI_API_KEY`      (paste your key at the prompt)
4. `npx wrangler deploy`                         (prints https://nutrisnap-api.<you>.workers.dev)
5. Put that address in `BACKEND_URL` in www/index.html, then push (see main README).

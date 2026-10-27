# StackSettle Pro

Mobile-first, offline-capable poker cash-game settlement app (TypeScript + Vite PWA, no runtime dependencies).

```
npm install
npm run dev        # local dev server
npm test           # settlement-engine unit tests
npm run build      # type-check + production build into dist/ (service worker included)
npm run preview    # serve dist/ to test install + offline
```

Deploy `dist/` to any HTTPS static host (GitHub Pages, Netlify, Vercel), open it on a phone, then
use **Add to Home Screen** / **Install app**.

- `src/engine.ts` – pure settlement logic (minimum-transfer solver, reconciliation, backup parsing/validation)
- `src/state.ts`, `src/storage.ts` – app state and localStorage persistence
- `src/main.ts`, `src/dom.ts`, `src/style.css` – iOS-style UI (no innerHTML; all text via textContent)
- `legacy/` – the original single-file HTML app, kept for reference

## Live view-only sharing

The host can share a link/code that lets everyone else watch the table live, read-only.
Only the host's device can change anything: it holds a secret *host key* (never shown, never sent to viewers),
and the server rejects every write without it.

- Host: **Table → Share** → *Start sharing* → send the link or code. *Stop sharing* kills it immediately.
- Viewer: open the link, or **Settings → Join a live game** and enter the code. Viewers get a separate
  read-only page that opens on the **oval table** (tap a seat for that player's buy-ins, chips and net) and can
  switch to a **list**; tables above 12 players show the list. It never loads or overwrites their own saved tables.
- Data is stored for **7 days after the host's last change** (rolling), then deleted. Reads do not extend it.

### How it works
```
phone (host) --PUT x-host-key--> /api/share --> Redis (7-day TTL)  <--GET (poll every 3 s)-- phones (viewers)
```
- `server/handler.ts` – all rules (validation, host-key check, rate limits, expiry); unit tested.
- `server/store.ts` – Upstash Redis over REST in production, in-memory store otherwise.
- `server/vercel.ts` → bundled by `npm run build:api` into **`api/share.js`** (committed; plain Node ESM, no TypeScript step on Vercel).
- `npm run dev` / `npm run preview` serve the same API locally with an in-memory store, so the whole feature works offline.

### Deploying on Vercel
1. Import the repo (Framework: Vite; build command `npm run build`, output `dist`).
2. In the project: **Storage → Create → Upstash Redis** (Marketplace) and connect it to the project. This injects
   `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`).
3. Redeploy. Without Redis the function falls back to per-instance memory, which does **not** work across
   serverless instances — sharing would appear to work and then randomly 404.

Abuse limits (per hour): 10 new shares / IP, 1500 host updates / code, 20,000 polls / IP, 40 unknown-code lookups / IP
(stops code guessing). Share codes are 8 characters from a 32-symbol alphabet (40 bits). Payloads are capped at 32 KB.

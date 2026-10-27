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

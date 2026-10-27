// Mounts /api/share in the Vite dev and preview servers, using an in-memory store, so the whole
// feature can be run and tested locally without Vercel or Redis.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LIMITS, MAX_BODY_BYTES, handleShare, memoryStore } from './handler';

// Local dev/preview only: many test browsers share one IP, so allow far more new shares than production.
const DEV_LIMITS = { ...LIMITS, create: { max: 500, window: 3600 }, claim: { max: 2000, window: 3600 } };

export function shareApiMiddleware() {
  const store = memoryStore();
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/share')) return next();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: 'Payload too large' }));
        return;
      }
      chunks.push(c as Buffer);
    }
    let body: unknown = null;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
    const url = new URL(req.url, 'http://localhost');
    const query: Record<string, string | undefined> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
    const out = await handleShare(
      { method: req.method ?? 'GET', query, headers, body, ip: req.socket.remoteAddress ?? 'dev' },
      store,
      Date.now(),
      DEV_LIMITS
    );
    res.statusCode = out.status;
    res.setHeader('Content-Type', 'application/json');
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
    res.end(JSON.stringify(out.body));
  };
}

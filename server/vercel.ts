// Vercel serverless function: /api/share. Bundled into api/share.js by `npm run build:api`.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_BODY_BYTES, handleShare, type ApiRequest } from './handler';
import { getStore } from './store';

type VercelLike = IncomingMessage & { query?: Record<string, string | string[] | undefined>; body?: unknown };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function handler(req: VercelLike, res: ServerResponse) {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    res.statusCode = 413;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Payload too large' }));
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query: Record<string, string | undefined> = {};
  for (const [k, v] of url.searchParams) query[k] = v;
  for (const [k, v] of Object.entries(req.query ?? {})) query[k] = first(v);

  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = first(v);

  const apiReq: ApiRequest = {
    method: req.method ?? 'GET',
    query,
    headers,
    body: req.body,
    ip: (headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
  };
  const out = await handleShare(apiReq, getStore());
  res.statusCode = out.status;
  res.setHeader('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
  res.end(JSON.stringify(out.body));
}

// Framework-free request handler for /api/share. The Vercel function, the Vite dev/preview
// middleware and the unit tests all call this, so the permission rules live in exactly one place.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { CODE_ALPHABET, CODE_LENGTH, SHARE_TTL_SECONDS, normalizeCode, sanitizeSnapshot, type SharedSnapshot } from '../src/shared';

export interface ApiRequest {
  method: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
  ip: string;
}
export interface ApiResponse { status: number; body: unknown; headers?: Record<string, string> }

export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Increments a counter that expires `ttlSeconds` after its first increment; returns the new value. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

interface Record_ { keyHash: string; snapshot: SharedSnapshot; rev: number; createdAt: number }

export const MAX_BODY_BYTES = 32 * 1024;
export const LIMITS = {
  create: { max: 10, window: 3600 },       // new shares per IP per hour
  write: { max: 1500, window: 3600 },      // host pushes per code per hour
  read: { max: 20000, window: 3600 },      // polls per IP per hour (a household shares one IP)
  miss: { max: 40, window: 3600 }          // unknown-code lookups per IP per hour: stops code guessing
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const json = (status: number, body: unknown, extra: Record<string, string> = {}): ApiResponse =>
  ({ status, body, headers: { 'Cache-Control': 'no-store', ...extra } });
const err = (status: number, message: string) => json(status, { error: message });

function newCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

function keyMatches(provided: string | undefined, keyHash: string): boolean {
  if (!provided || provided.length > 200) return false;
  const a = Buffer.from(sha256(provided));
  const b = Buffer.from(keyHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function load(store: Store, code: string): Promise<Record_ | null> {
  const raw = await store.get(`share:${code}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as Record_; } catch { return null; }
}

async function limited(store: Store, key: string, rule: { max: number; window: number }): Promise<boolean> {
  return (await store.incr(key, rule.window)) > rule.max;
}

export type Limits = typeof LIMITS;

export async function handleShare(req: ApiRequest, store: Store, now = Date.now(), limits: Limits = LIMITS): Promise<ApiResponse> {
  const method = req.method.toUpperCase();
  const ip = req.ip || 'unknown';

  try {
    if (method === 'POST') {
      if (await limited(store, `rl:create:${ip}`, limits.create)) return err(429, 'Too many new shares, try again later');
      const snapshot = sanitizeSnapshot((req.body as { snapshot?: unknown } | null)?.snapshot, now);
      if (!snapshot) return err(400, 'Invalid session');
      let code = newCode();
      for (let i = 0; i < 5 && (await store.get(`share:${code}`)); i++) code = newCode();
      const hostKey = randomBytes(24).toString('base64url');
      const rec: Record_ = { keyHash: sha256(hostKey), snapshot, rev: 1, createdAt: now };
      await store.set(`share:${code}`, JSON.stringify(rec), SHARE_TTL_SECONDS);
      return json(201, { code, hostKey, rev: 1, expiresAt: now + SHARE_TTL_SECONDS * 1000 });
    }

    const code = normalizeCode(req.query.code);
    if (!code) return err(400, 'Invalid code');

    if (method === 'GET') {
      if (await limited(store, `rl:read:${ip}`, limits.read)) return err(429, 'Too many requests');
      const rec = await load(store, code);
      if (!rec) {
        if (await limited(store, `rl:miss:${ip}`, limits.miss)) return err(429, 'Too many requests');
        return err(404, 'Not found or expired');
      }
      const since = Number(req.query.since);
      if (Number.isFinite(since) && since === rec.rev) return json(200, { unchanged: true, rev: rec.rev });
      // The host key hash never leaves the server.
      return json(200, { snapshot: rec.snapshot, rev: rec.rev, expiresAt: rec.snapshot.updatedAt + SHARE_TTL_SECONDS * 1000 });
    }

    if (method === 'PUT' || method === 'DELETE') {
      const rec = await load(store, code);
      if (!rec) return err(404, 'Not found or expired');
      if (!keyMatches(req.headers['x-host-key'], rec.keyHash)) return err(403, 'Only the host can change this table');
      if (method === 'DELETE') { await store.del(`share:${code}`); return json(200, { ok: true }); }
      if (await limited(store, `rl:write:${code}`, limits.write)) return err(429, 'Too many updates');
      const snapshot = sanitizeSnapshot((req.body as { snapshot?: unknown } | null)?.snapshot, now);
      if (!snapshot) return err(400, 'Invalid session');
      const next: Record_ = { ...rec, snapshot, rev: rec.rev + 1 };
      await store.set(`share:${code}`, JSON.stringify(next), SHARE_TTL_SECONDS); // rolling 7 days from the last host edit
      return json(200, { rev: next.rev, expiresAt: now + SHARE_TTL_SECONDS * 1000 });
    }

    return { ...err(405, 'Method not allowed'), headers: { Allow: 'GET, POST, PUT, DELETE', 'Cache-Control': 'no-store' } };
  } catch {
    return err(500, 'Server error');
  }
}

/** In-memory store with real expiry; used for local dev/preview and tests. */
export function memoryStore(clock: () => number = Date.now): Store & { size(): number } {
  const data = new Map<string, { v: string; exp: number }>();
  const live = (k: string) => {
    const e = data.get(k);
    if (!e) return undefined;
    if (e.exp <= clock()) { data.delete(k); return undefined; }
    return e;
  };
  return {
    async get(k) { return live(k)?.v ?? null; },
    async set(k, v, ttl) { data.set(k, { v, exp: clock() + ttl * 1000 }); },
    async del(k) { data.delete(k); },
    async incr(k, ttl) {
      const e = live(k);
      const n = e ? Number(e.v) + 1 : 1;
      data.set(k, { v: String(n), exp: e ? e.exp : clock() + ttl * 1000 });
      return n;
    },
    size() { return data.size; }
  };
}

// Framework-free request handler for /api/share. The Vercel function, the Vite dev/preview
// middleware and the unit tests all call this, so the permission rules live in exactly one place.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  CODE_ALPHABET, CODE_LENGTH, KEY_HASH_RE, OFFER_TTL_MS, SHARE_TTL_SECONDS, normalizeCode, sanitizeSnapshot,
  type PublicOffer, type SharedSnapshot
} from '../src/shared';

export interface ApiRequest {
  method: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
  ip: string;
}
export interface ApiResponse { status: number; body: unknown; headers?: Record<string, string> }

/** Thrown by a store that has no real backend (production without Redis): never silently use memory. */
export class StorageNotConfigured extends Error {
  constructor() { super('Sharing storage is not configured'); this.name = 'StorageNotConfigured'; }
}

export interface Store {
  /** which backend this is, for the health check */
  readonly kind?: 'redis' | 'memory' | 'unconfigured';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Increments a counter that expires `ttlSeconds` after its first increment; returns the new value. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

interface Offer {
  kind: 'seat' | 'link';
  playerId?: string;
  /** link offers only: hash of the one-time token that is shown in the QR code */
  tokenHash?: string;
  expiresAt: number;
  /** seat offers: a viewer accepted; waiting for the host to confirm. keyHash = hash of the key that viewer generated. */
  claim?: { keyHash: string; at: number };
}
interface Record_ {
  keyHash: string;
  snapshot: SharedSnapshot;
  rev: number;
  createdAt: number;
  /** increments every time the host key changes hands */
  epoch?: number;
  /** when the store will drop this record (ms since epoch); refreshed by every write */
  expiresAt?: number;
  offer?: Offer;
}

export const MAX_BODY_BYTES = 32 * 1024;
export const LIMITS = {
  create: { max: 10, window: 3600 },       // new shares per IP per hour
  write: { max: 1500, window: 3600 },      // host pushes per code per hour
  read: { max: 20000, window: 3600 },      // polls per IP per hour (a household shares one IP)
  miss: { max: 40, window: 3600 },         // unknown-code lookups per IP per hour: stops code guessing
  claim: { max: 40, window: 3600 },        // handover claims per IP per hour
  claimCode: { max: 60, window: 3600 }     // handover claims per code per hour (stops token guessing)
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

const sha256hex = sha256;

function liveOffer(rec: Record_, now: number): Offer | undefined {
  return rec.offer && rec.offer.expiresAt > now ? rec.offer : undefined;
}

/** What viewers may see: no token, no hashes. */
function publicOffer(rec: Record_, now: number): PublicOffer | undefined {
  const o = liveOffer(rec, now);
  if (!o) return undefined;
  return { kind: o.kind, playerId: o.playerId, expiresAt: o.expiresAt, status: o.claim ? 'claimed' : 'open' };
}

/** Every write goes through here so the stored lifetime and the reported expiry can never disagree. */
async function persist(store: Store, code: string, rec: Record_, now: number): Promise<void> {
  rec.expiresAt = now + SHARE_TTL_SECONDS * 1000;
  await store.set(`share:${code}`, JSON.stringify(rec), SHARE_TTL_SECONDS);
}

/** A missing record is either one the host stopped on purpose (tombstone) or expired/unknown. */
async function gone(store: Store, code: string): Promise<ApiResponse> {
  const stopped = (await store.get(`tomb:${code}`)) !== null;
  return json(404, {
    error: stopped ? 'The host stopped sharing this table' : 'Not found or expired',
    reason: stopped ? 'stopped' : 'expired_or_unknown'
  });
}

async function limited(store: Store, key: string, rule: { max: number; window: number }): Promise<boolean> {
  return (await store.incr(key, rule.window)) > rule.max;
}

export type Limits = typeof LIMITS;

export async function handleShare(req: ApiRequest, store: Store, now = Date.now(), limits: Limits = LIMITS): Promise<ApiResponse> {
  const method = req.method.toUpperCase();
  const ip = req.ip || 'unknown';

  try {
    if (method === 'POST' && !req.query.action) {
      if (await limited(store, `rl:create:${ip}`, limits.create)) return err(429, 'Too many new shares, try again later');
      const snapshot = sanitizeSnapshot((req.body as { snapshot?: unknown } | null)?.snapshot, now);
      if (!snapshot) return err(400, 'Invalid session');
      let code = newCode();
      for (let i = 0; i < 5 && (await store.get(`share:${code}`)); i++) code = newCode();
      const hostKey = randomBytes(24).toString('base64url');
      const rec: Record_ = { keyHash: sha256(hostKey), snapshot, rev: 1, createdAt: now, epoch: 1 };
      await persist(store, code, rec, now);
      return json(201, { code, hostKey, rev: 1, epoch: 1, expiresAt: now + SHARE_TTL_SECONDS * 1000 });
    }

    if (method === 'GET' && req.query.action === 'health' && !req.query.code) {
      await store.get('health:ping'); // throws StorageNotConfigured when there is no backend
      return json(200, { ok: true, store: store.kind ?? 'unknown' });
    }

    const code = normalizeCode(req.query.code);
    if (!code) return err(400, 'Invalid code');

    if (req.query.action) return handleAction(req, store, code, now, limits, ip);

    if (method === 'GET') {
      if (await limited(store, `rl:read:${ip}`, limits.read)) return err(429, 'Too many requests');
      const rec = await load(store, code);
      if (!rec) {
        const g = await gone(store, code);
        // only genuinely unknown codes count towards the guessing limit
        if ((g.body as { reason: string }).reason !== 'stopped' && await limited(store, `rl:miss:${ip}`, limits.miss)) return err(429, 'Too many requests');
        return g;
      }
      const since = Number(req.query.since);
      if (Number.isFinite(since) && since === rec.rev) return json(200, { unchanged: true, rev: rec.rev });
      // The host key hash never leaves the server.
      return json(200, {
        snapshot: rec.snapshot, rev: rec.rev, epoch: rec.epoch ?? 1, offer: publicOffer(rec, now),
        expiresAt: rec.expiresAt ?? rec.snapshot.updatedAt + SHARE_TTL_SECONDS * 1000
      });
    }

    if (method === 'PUT' || method === 'DELETE') {
      const rec = await load(store, code);
      if (!rec) return gone(store, code);
      if (!keyMatches(req.headers['x-host-key'], rec.keyHash)) return err(403, 'Only the host can change this table');
      if (method === 'DELETE') {
        await store.del(`share:${code}`);
        await store.set(`tomb:${code}`, '1', SHARE_TTL_SECONDS); // so viewers can be told it was stopped, not expired
        return json(200, { ok: true });
      }
      if (await limited(store, `rl:write:${code}`, limits.write)) return err(429, 'Too many updates');
      const snapshot = sanitizeSnapshot((req.body as { snapshot?: unknown } | null)?.snapshot, now);
      if (!snapshot) return err(400, 'Invalid session');
      const next: Record_ = { ...rec, snapshot, rev: rec.rev + 1 };
      await persist(store, code, next, now);
      return json(200, { rev: next.rev, epoch: next.epoch ?? 1, expiresAt: now + SHARE_TTL_SECONDS * 1000 });
    }

    return { ...err(405, 'Method not allowed'), headers: { Allow: 'GET, POST, PUT, DELETE', 'Cache-Control': 'no-store' } };
  } catch (e) {
    if (e instanceof StorageNotConfigured) {
      return json(503, { error: 'Sharing storage is not configured on this server', reason: 'storage_not_configured' });
    }
    return err(500, 'Server error');
  }
}

/**
 * Handing the table to someone else. Every path ends the same way: the stored host-key hash is replaced by
 * a hash the NEW host generated on their own phone, so the server never sees or stores a usable key, and
 * the old host's key stops working at once.
 *   offer  (host key)   POST: open an offer {kind:'seat',playerId} or {kind:'link'}; DELETE: withdraw it
 *   claim  (no key)     POST: a seat offer is accepted by a viewer ({keyHash}) -> waits for host approval;
 *                       a link offer is taken with its one-time token ({token,keyHash}) -> immediate
 *   approve(host key)   POST {approve:boolean}: confirm or decline a seat claim
 *   verify (host key)   POST: "am I still the host?"
 */
async function handleAction(
  req: ApiRequest, store: Store, code: string, now: number, limits: Limits, ip: string
): Promise<ApiResponse> {
  const action = req.query.action;
  const method = req.method.toUpperCase();
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

  if (action === 'claim') {
    if (method !== 'POST') return err(405, 'Method not allowed');
    if (await limited(store, `rl:claim:${ip}`, limits.claim) || await limited(store, `rl:claimcode:${code}`, limits.claimCode)) {
      return err(429, 'Too many attempts, try again later');
    }
    const rec = await load(store, code);
    if (!rec) return gone(store, code);
    const offer = liveOffer(rec, now);
    if (!offer) return err(404, 'No hand-over is open');
    const keyHash = typeof body.keyHash === 'string' ? body.keyHash : '';
    if (!KEY_HASH_RE.test(keyHash)) return err(400, 'Invalid key');

    if (offer.kind === 'link') {
      const token = typeof body.token === 'string' ? body.token : '';
      if (!token || token.length > 200 || !offer.tokenHash || !keyMatches(token, offer.tokenHash)) {
        return err(403, 'This hand-over code is not valid');
      }
      const next: Record_ = { ...rec, keyHash, epoch: (rec.epoch ?? 1) + 1, rev: rec.rev + 1, offer: undefined };
      await persist(store, code, next, now);
      return json(200, { ok: true, snapshot: next.snapshot, rev: next.rev, epoch: next.epoch });
    }

    // seat offer: needs the host to confirm, so it only records the claim
    if (offer.claim && now - offer.claim.at < 2 * 60 * 1000) return err(409, 'Someone else already accepted — wait for the host');
    const next: Record_ = { ...rec, rev: rec.rev + 1, offer: { ...offer, claim: { keyHash, at: now } } };
    await persist(store, code, next, now);
    return json(200, { ok: true, rev: next.rev });
  }

  // everything below is host-only
  const rec = await load(store, code);
  if (!rec) return gone(store, code);
  if (!keyMatches(req.headers['x-host-key'], rec.keyHash)) return err(403, 'Only the host can change this table');

  if (action === 'verify') {
    if (method !== 'POST') return err(405, 'Method not allowed');
    return json(200, { ok: true, epoch: rec.epoch ?? 1 });
  }

  if (action === 'offer') {
    if (method === 'DELETE') {
      const next: Record_ = { ...rec, rev: rec.rev + 1, offer: undefined };
      await persist(store, code, next, now);
      return json(200, { ok: true });
    }
    if (method !== 'POST') return err(405, 'Method not allowed');
    if (await limited(store, `rl:write:${code}`, limits.write)) return err(429, 'Too many updates');
    const kind = body.kind;
    let offer: Offer;
    let token: string | undefined;
    if (kind === 'seat') {
      const playerId = typeof body.playerId === 'string' ? body.playerId : '';
      if (!rec.snapshot.players.some(p => p.id === playerId)) return err(400, 'Unknown player');
      offer = { kind: 'seat', playerId, expiresAt: now + OFFER_TTL_MS };
    } else if (kind === 'link') {
      token = randomBytes(18).toString('base64url');
      offer = { kind: 'link', tokenHash: sha256hex(token), expiresAt: now + OFFER_TTL_MS };
    } else {
      return err(400, 'Invalid offer');
    }
    const next: Record_ = { ...rec, rev: rec.rev + 1, offer };
    await persist(store, code, next, now);
    // the token is returned exactly once, to the host who asked for it
    return json(201, { offer: publicOffer(next, now), token, rev: next.rev });
  }

  if (action === 'approve') {
    if (method !== 'POST') return err(405, 'Method not allowed');
    const offer = liveOffer(rec, now);
    if (!offer || offer.kind !== 'seat' || !offer.claim) return err(409, 'Nobody has accepted');
    if (body.approve === true) {
      const next: Record_ = { ...rec, keyHash: offer.claim.keyHash, epoch: (rec.epoch ?? 1) + 1, rev: rec.rev + 1, offer: undefined };
      await persist(store, code, next, now);
      return json(200, { ok: true, epoch: next.epoch });
    }
    const next: Record_ = { ...rec, rev: rec.rev + 1, offer: { ...offer, claim: undefined } };
    await persist(store, code, next, now);
    return json(200, { ok: true, declined: true });
  }

  return err(400, 'Unknown action');
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
    kind: 'memory' as const,
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

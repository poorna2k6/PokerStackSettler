// Framework-free request handler for /api/share. The Vercel function, the Vite dev/preview
// middleware and the unit tests all call this, so the permission rules live in exactly one place.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  CODE_ALPHABET, CODE_LENGTH, KEY_HASH_RE, OFFER_TTL_MS, SHARE_TTL_SECONDS, normalizeCode, pickFinalTtl, pickTtl, sanitizeSnapshot,
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
  /** Writes only if the key currently holds exactly `expected` (null = must not exist). Atomic. */
  setIf(key: string, value: string, ttlSeconds: number, expected: string | null): Promise<boolean>;
  /** Deletes only if the key currently holds exactly `expected`. Atomic. */
  delIf(key: string, expected: string): Promise<boolean>;
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
  /** the host's chosen rolling lifetime in seconds (missing on old records = 7 days) */
  ttl?: number;
  /** set when the host settles: the link then lives for finalTtl seconds from this moment and is no longer renewed */
  settledAt?: number;
  finalTtl?: number;
  offer?: Offer;
}

const ttlOf = (rec: { ttl?: number } | null | undefined) => pickTtl(rec?.ttl);
const untilOf = (rec: Record_, now: number) => (rec.settledAt && rec.finalTtl ? rec.settledAt + rec.finalTtl * 1000 : now + ttlOf(rec) * 1000);

export const MAX_BODY_BYTES = 32 * 1024;
export const LIMITS = {
  create: { max: 10, window: 3600 },       // new shares per IP per hour
  write: { max: 1500, window: 3600 },      // host pushes per code per hour
  read: { max: 20000, window: 3600 },      // polls per IP per hour (a household shares one IP)
  miss: { max: 200, window: 3600 },         // unknown-code lookups per IP per hour: stops code guessing
  claim: { max: 40, window: 3600 }         // per IP per hour: seat requests and FAILED token attempts (a valid token is never throttled)
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

interface Step { next?: Record_; remove?: boolean; res: ApiResponse }

/**
 * The ONLY way a stored table changes after creation. Read the record, decide, and write it back only if nobody
 * changed it in between (compare-and-set); otherwise start over from the fresh record. This is what makes two
 * phones using the same hand-over code at the same moment resolve to exactly one winner, and stops a stale host
 * save from bringing the old key back. Every write also refreshes the stored lifetime and the reported expiry.
 * `fn` runs again on a retry, so it must not have side effects (rate limits are applied before calling this).
 */
async function mutate(
  store: Store, code: string, now: number,
  fn: (rec: Record_ | null) => Step | Promise<Step>
): Promise<ApiResponse> {
  const key = `share:${code}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await store.get(key);
    let rec: Record_ | null = null;
    if (raw) { try { rec = JSON.parse(raw) as Record_; } catch { rec = null; } }
    const step = await fn(rec);
    if (step.remove && raw) {
      if (await store.delIf(key, raw)) {
        await store.set(`tomb:${code}`, '1', SHARE_TTL_SECONDS); // so viewers can be told it was stopped, not expired
        return step.res;
      }
      continue;
    }
    if (!step.next) return step.res;
    let ttl = ttlOf(step.next);
    step.next.expiresAt = now + ttl * 1000;
    if (step.next.settledAt && step.next.finalTtl) {
      // a settled table has a fixed end of life: it is not extended by later saves, heartbeats or hand-overs
      step.next.expiresAt = step.next.settledAt + step.next.finalTtl * 1000;
      ttl = Math.max(1, Math.ceil((step.next.expiresAt - now) / 1000));
    }
    if (await store.setIf(key, JSON.stringify(step.next), ttl, raw)) return step.res;
  }
  return err(409, 'The table is busy — try again');
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

/**
 * With a server secret, every host key we hand out is `random.proof` where proof = HMAC(secret, code + random). A table
 * that was lost can then only be restored by someone holding a key that carries a valid proof for that code, i.e. the
 * real host; a viewer who only knows the public code cannot forge one. Without a secret (plain temporary memory
 * storage) there is nothing to check against, so restoring is open to anyone who knows the code.
 */
const proof = (secret: string, code: string, rand: string) => createHmac('sha256', secret).update(`${code}:${rand}`).digest('base64url').slice(0, 22);
const keyProofOk = (secret: string | undefined, code: string, key: string) => {
  if (!secret) return true;
  const dot = key.lastIndexOf('.');
  if (dot < 1) return false;
  const expected = proof(secret, code, key.slice(0, dot));
  const given = key.slice(dot + 1);
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
};

export async function handleShare(req: ApiRequest, store: Store, now = Date.now(), limits: Limits = LIMITS, secret?: string): Promise<ApiResponse> {
  const method = req.method.toUpperCase();
  const ip = req.ip || 'unknown';

  try {
    if (method === 'POST' && !req.query.action) {
      if (await limited(store, `rl:create:${ip}`, limits.create)) return err(429, 'Too many new shares, try again later');
      const snapshot = sanitizeSnapshot((req.body as { snapshot?: unknown } | null)?.snapshot, now);
      if (!snapshot) return err(400, 'Invalid session');
      const rand = randomBytes(24).toString('base64url');
      const ttl = pickTtl((req.body as { ttlSeconds?: unknown } | null)?.ttlSeconds);
      for (let i = 0; i < 5; i++) {
        const code = newCode();
        const hostKey = secret ? `${rand}.${proof(secret, code, rand)}` : rand;
        const rec: Record_ = { keyHash: sha256(hostKey), snapshot, rev: 1, createdAt: now, epoch: 1, ttl, expiresAt: now + ttl * 1000 };
        if (await store.setIf(`share:${code}`, JSON.stringify(rec), ttl, null)) {
          return json(201, { code, hostKey, rev: 1, epoch: 1, ttl, expiresAt: rec.expiresAt });
        }
      }
      return err(500, 'Could not allocate a code');
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
        ttl: ttlOf(rec), expiresAt: rec.expiresAt ?? rec.snapshot.updatedAt + ttlOf(rec) * 1000
      });
    }

    if (method === 'PUT' || method === 'DELETE') {
      const hostKey = req.headers['x-host-key'];
      if (method === 'PUT') {
        if (await limited(store, `rl:write:${code}`, limits.write)) return err(429, 'Too many updates');
        const snapshot = sanitizeSnapshot((req.body as { snapshot?: unknown } | null)?.snapshot, now);
        if (!snapshot) return err(400, 'Invalid session');
        const heartbeat = req.query.heartbeat === '1';
        const restore = req.query.restore === '1' && typeof hostKey === 'string' && hostKey.length >= 16 && hostKey.length <= 200 && keyProofOk(secret, code, hostKey);
        const askedTtl = (req.body as { ttlSeconds?: unknown } | null)?.ttlSeconds;
        if (restore && (await store.get(`share:${code}`)) === null && (await store.get(`tomb:${code}`)) === null) {
          // The server lost this table (e.g. temporary storage restarted) but the host's phone still has it: put it back
          // under the SAME code and key. A table the host deliberately stopped (tombstone) is never brought back.
          if (await limited(store, `rl:create:${ip}`, limits.create)) return err(429, 'Too many new shares, try again later');
          const ttl = pickTtl(askedTtl);
          const rec: Record_ = { keyHash: sha256(hostKey as string), snapshot, rev: 1, createdAt: now, epoch: 1, ttl, expiresAt: now + ttl * 1000 };
          let life = ttl;
          if (snapshot.isEnded) {
            rec.settledAt = now;
            rec.finalTtl = pickFinalTtl((req.body as { finalTtlSeconds?: unknown } | null)?.finalTtlSeconds);
            rec.expiresAt = now + rec.finalTtl * 1000;
            life = rec.finalTtl;
          }
          if (await store.setIf(`share:${code}`, JSON.stringify(rec), life, null)) {
            return json(200, { rev: 1, epoch: 1, ttl, expiresAt: rec.expiresAt, restored: true });
          }
        }
        return mutate(store, code, now, async rec => {
          if (!rec) return { res: await gone(store, code) };
          if (!keyMatches(hostKey, rec.keyHash)) return { res: err(403, 'Only the host can change this table') };
          // A heartbeat only says "the host's app is still open": it renews the lifetime and changes nothing else.
          if (heartbeat) {
            const kept: Record_ = { ...rec };
            return { next: kept, res: json(200, { rev: kept.rev, epoch: kept.epoch ?? 1, ttl: ttlOf(kept), expiresAt: untilOf(kept, now) }) };
          }
          const next: Record_ = { ...rec, snapshot, rev: rec.rev + 1 };
          const askedFinal = (req.body as { finalTtlSeconds?: unknown } | null)?.finalTtlSeconds;
          if (snapshot.isEnded) {
            next.settledAt = rec.settledAt ?? now; // the clock starts the first time it is settled
            next.finalTtl = pickFinalTtl(askedFinal, rec.finalTtl);
          } else { delete next.settledAt; delete next.finalTtl; } // reopened: back to a rolling lifetime
          // The host may change the lifetime later ("Extend"); only a listed value counts, otherwise it is kept.
          next.ttl = pickTtl((req.body as { ttlSeconds?: unknown } | null)?.ttlSeconds, ttlOf(rec));
          const until = next.settledAt && next.finalTtl ? next.settledAt + next.finalTtl * 1000 : now + next.ttl * 1000;
          return { next, res: json(200, { rev: next.rev, epoch: next.epoch ?? 1, ttl: next.ttl, finalTtl: next.finalTtl, expiresAt: until }) };
        });
      }
      return mutate(store, code, now, async rec => {
        if (!rec) return { res: await gone(store, code) };
        if (!keyMatches(hostKey, rec.keyHash)) return { res: err(403, 'Only the host can change this table') };
        return { remove: true, res: json(200, { ok: true }) };
      });
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
    const keyHash = typeof body.keyHash === 'string' ? body.keyHash : '';
    if (!KEY_HASH_RE.test(keyHash)) return err(400, 'Invalid key');
    const token = typeof body.token === 'string' ? body.token : '';

    // Throttling is per IP and only for seat requests and FAILED token guesses: a bystander can no longer use up a
    // shared per-code budget to lock the host's own QR out, and a valid token always gets through.
    const throttled = () => limited(store, `rl:claim:${ip}`, limits.claim);
    let counted = false;
    const countOnce = async () => { if (counted) return false; counted = true; return throttled(); };

    return mutate(store, code, now, async rec => {
      if (!rec) return { res: await gone(store, code) };
      const offer = liveOffer(rec, now);
      if (!offer) return { res: err(404, 'No hand-over is open') };

      if (offer.kind === 'link') {
        if (!token || token.length > 200 || !offer.tokenHash || !keyMatches(token, offer.tokenHash)) {
          return { res: (await countOnce()) ? err(429, 'Too many attempts, try again later') : err(403, 'This hand-over code is not valid') };
        }
        const next: Record_ = { ...rec, keyHash, epoch: (rec.epoch ?? 1) + 1, rev: rec.rev + 1, offer: undefined };
        return { next, res: json(200, { ok: true, snapshot: next.snapshot, rev: next.rev, epoch: next.epoch }) };
      }

      // seat offer: needs the host to confirm, so it only records the claim
      if (offer.claim && now - offer.claim.at < 2 * 60 * 1000) return { res: err(409, 'Someone else already accepted — wait for the host') };
      if (await countOnce()) return { res: err(429, 'Too many attempts, try again later') };
      const next: Record_ = { ...rec, rev: rec.rev + 1, offer: { ...offer, claim: { keyHash, at: now } } };
      return { next, res: json(200, { ok: true, rev: next.rev }) };
    });
  }

  // everything below is host-only
  const hostKey = req.headers['x-host-key'];

  if (action === 'verify') {
    if (method !== 'POST') return err(405, 'Method not allowed');
    const rec = await load(store, code);
    if (!rec) return gone(store, code);
    if (!keyMatches(hostKey, rec.keyHash)) return err(403, 'Only the host can change this table');
    return json(200, { ok: true, epoch: rec.epoch ?? 1 });
  }

  if (action === 'offer') {
    if (method === 'DELETE') {
      return mutate(store, code, now, async rec => {
        if (!rec) return { res: await gone(store, code) };
        if (!keyMatches(hostKey, rec.keyHash)) return { res: err(403, 'Only the host can change this table') };
        return { next: { ...rec, rev: rec.rev + 1, offer: undefined }, res: json(200, { ok: true }) };
      });
    }
    if (method !== 'POST') return err(405, 'Method not allowed');
    if (await limited(store, `rl:write:${code}`, limits.write)) return err(429, 'Too many updates');
    const kind = body.kind;
    if (kind !== 'seat' && kind !== 'link') {
      // still answer 403 to non-hosts before revealing anything about validation
      const rec = await load(store, code);
      if (!rec) return gone(store, code);
      if (!keyMatches(hostKey, rec.keyHash)) return err(403, 'Only the host can change this table');
      return err(400, 'Invalid offer');
    }
    return mutate(store, code, now, async rec => {
      if (!rec) return { res: await gone(store, code) };
      if (!keyMatches(hostKey, rec.keyHash)) return { res: err(403, 'Only the host can change this table') };
      let offer: Offer;
      let token: string | undefined;
      if (kind === 'seat') {
        const playerId = typeof body.playerId === 'string' ? body.playerId : '';
        if (!rec.snapshot.players.some(p => p.id === playerId)) return { res: err(400, 'Unknown player') };
        offer = { kind: 'seat', playerId, expiresAt: now + OFFER_TTL_MS };
      } else {
        token = randomBytes(18).toString('base64url');
        offer = { kind: 'link', tokenHash: sha256hex(token), expiresAt: now + OFFER_TTL_MS };
      }
      const next: Record_ = { ...rec, rev: rec.rev + 1, offer };
      // the token is returned exactly once, to the host who asked for it
      return { next, res: json(201, { offer: publicOffer(next, now), token, rev: next.rev }) };
    });
  }

  if (action === 'approve') {
    if (method !== 'POST') return err(405, 'Method not allowed');
    return mutate(store, code, now, async rec => {
      if (!rec) return { res: await gone(store, code) };
      if (!keyMatches(hostKey, rec.keyHash)) return { res: err(403, 'Only the host can change this table') };
      const offer = liveOffer(rec, now);
      if (!offer || offer.kind !== 'seat' || !offer.claim) return { res: err(409, 'Nobody has accepted') };
      if (body.approve === true) {
        const next: Record_ = { ...rec, keyHash: offer.claim.keyHash, epoch: (rec.epoch ?? 1) + 1, rev: rec.rev + 1, offer: undefined };
        return { next, res: json(200, { ok: true, epoch: next.epoch }) };
      }
      return { next: { ...rec, rev: rec.rev + 1, offer: { ...offer, claim: undefined } }, res: json(200, { ok: true, declined: true }) };
    });
  }

  // unknown actions: stay quiet for non-hosts, as before
  const rec = await load(store, code);
  if (!rec) return gone(store, code);
  if (!keyMatches(hostKey, rec.keyHash)) return err(403, 'Only the host can change this table');
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
    async setIf(k, v, ttl, expected) {
      if ((live(k)?.v ?? null) !== expected) return false;
      data.set(k, { v, exp: clock() + ttl * 1000 });
      return true;
    },
    async delIf(k, expected) {
      if (live(k)?.v !== expected) return false;
      data.delete(k);
      return true;
    },
    async incr(k, ttl) {
      const e = live(k);
      const n = e ? Number(e.v) + 1 : 1;
      data.set(k, { v: String(n), exp: e ? e.exp : clock() + ttl * 1000 });
      return n;
    },
    size() { return data.size; }
  };
}

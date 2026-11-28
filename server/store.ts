// Picks the storage backend. Production uses Upstash Redis through its REST API (Vercel's Upstash/KV
// integration injects these variables).
//
// Without them we must NOT quietly fall back to memory on Vercel: serverless instances do not share memory,
// so a share would "work" and then randomly 404 / look expired. There the store refuses every call and the
// API answers 503 "storage_not_configured". Plain memory is only used for local dev, tests and previews
// (or when ALLOW_MEMORY_STORE=1 is set on purpose).
import { StorageNotConfigured, memoryStore, type Store } from './handler';

const SET_IF = "local c = redis.call('GET', KEYS[1]); if (c == false and ARGV[1] == '') or c == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]); return 1 end; return 0";
// one atomic step: increment, and start the expiry when the counter is created (so no counter can outlive its window)
const INCR_EXPIRE = "local v = redis.call('INCR', KEYS[1]); if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return v";
const DEL_IF = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]); return 1 end; return 0";

export function upstash(url: string, token: string, fetchImpl: typeof fetch = fetch): Store {
  const cmd = async (args: (string | number)[]): Promise<unknown> => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    if (!res.ok) throw new Error(`Upstash ${res.status}`);
    return ((await res.json()) as { result: unknown }).result;
  };
  return {
    kind: 'redis',
    async get(key) { return ((await cmd(['GET', key])) as string | null) ?? null; },
    async set(key, value, ttl) { await cmd(['SET', key, value, 'EX', ttl]); },
    async del(key) { await cmd(['DEL', key]); },
    // Compare-and-set as small Lua scripts so the check and the write are one atomic step on the Redis server.
    async setIf(key, value, ttl, expected) {
      return Number(await cmd(['EVAL', SET_IF, 1, key, expected ?? '', value, ttl])) === 1;
    },
    async delIf(key, expected) {
      return Number(await cmd(['EVAL', DEL_IF, 1, key, expected])) === 1;
    },
    async incr(key, ttl) {
      // Create the key WITH its expiry first (no-op if it exists), then increment: a failure between the two
      // calls can no longer leave a counter that never expires.
      return Number(await cmd(['EVAL', INCR_EXPIRE, 1, key, ttl]));
    }
  };
}

export function unconfiguredStore(): Store {
  const fail = async (): Promise<never> => { throw new StorageNotConfigured(); };
  return { kind: 'unconfigured', get: fail, set: fail, del: fail, setIf: fail, delIf: fail, incr: fail };
}

/**
 * Finds the Redis REST URL and (read-write) token. Vercel's integration lets you choose a prefix for the variable
 * names (for example POKER_REDIS_KV_REST_API_URL), so besides the plain names any `<prefix>_KV_REST_API_URL` /
 * `<prefix>_UPSTASH_REDIS_REST_URL` with its matching token is accepted. READ_ONLY tokens are never used.
 */
export function redisCreds(env: Record<string, string | undefined>): { url: string; token: string } | null {
  const pairs: [string, string][] = [['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'], ['KV_REST_API_URL', 'KV_REST_API_TOKEN']];
  const ok = (url?: string, token?: string) => (url && token && /^https:\/\//.test(url) ? { url, token } : null);
  // plain names first, then any prefix; the URL and the token must come from the SAME prefix, and never a read-only token
  for (const [u, t] of pairs) { const r = ok(env[u], env[t]); if (r) return r; }
  for (const key of Object.keys(env)) {
    for (const [u, t] of pairs) {
      if (!key.endsWith(`_${u}`) || /READ_?ONLY/i.test(key)) continue;
      const tokenKey = `${key.slice(0, key.length - u.length)}${t}`;
      if (/READ_?ONLY/i.test(tokenKey)) continue;
      const r = ok(env[key], env[tokenKey]);
      if (r) return r;
    }
  }
  return null;
}

export function pickStore(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Store {
  const creds = redisCreds(env);
  if (creds) return upstash(creds.url, creds.token, fetchImpl);
  // Temporary memory storage keeps sharing usable until Redis is connected, but links can disappear when Vercel
  // restarts or switches server instances. Set ALLOW_MEMORY_STORE=0 to refuse instead (503 storage_not_configured).
  if (env.VERCEL && env.ALLOW_MEMORY_STORE === '0') {
    console.error('[share] Sharing storage is NOT configured: connect Upstash Redis to this Vercel project (Storage tab) and redeploy. Sharing is disabled until then.');
    return unconfiguredStore();
  }
  if (env.VERCEL) console.error('[share] No Redis connected: using temporary memory storage. Links may vanish. Connect Upstash Redis (Storage tab) and redeploy.');
  return memoryStore();
}

let cached: Store | undefined;
export function getStore(): Store {
  return (cached ??= pickStore(process.env));
}

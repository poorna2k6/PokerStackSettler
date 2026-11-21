// Picks the storage backend. Production uses Upstash Redis through its REST API (Vercel's Upstash/KV
// integration injects these variables).
//
// Without them we must NOT quietly fall back to memory on Vercel: serverless instances do not share memory,
// so a share would "work" and then randomly 404 / look expired. There the store refuses every call and the
// API answers 503 "storage_not_configured". Plain memory is only used for local dev, tests and previews
// (or when ALLOW_MEMORY_STORE=1 is set on purpose).
import { StorageNotConfigured, memoryStore, type Store } from './handler';

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
    async incr(key, ttl) {
      // Create the key WITH its expiry first (no-op if it exists), then increment: a failure between the two
      // calls can no longer leave a counter that never expires.
      await cmd(['SET', key, 0, 'EX', ttl, 'NX']);
      return Number(await cmd(['INCR', key]));
    }
  };
}

export function unconfiguredStore(): Store {
  const fail = async (): Promise<never> => { throw new StorageNotConfigured(); };
  return { kind: 'unconfigured', get: fail, set: fail, del: fail, incr: fail };
}

export function pickStore(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Store {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (url && token) return upstash(url, token, fetchImpl);
  if (env.VERCEL && env.ALLOW_MEMORY_STORE !== '1') {
    console.error('[share] Sharing storage is NOT configured: connect Upstash Redis to this Vercel project (Storage tab) and redeploy. Sharing is disabled until then.');
    return unconfiguredStore();
  }
  return memoryStore();
}

let cached: Store | undefined;
export function getStore(): Store {
  return (cached ??= pickStore(process.env));
}

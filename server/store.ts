// Picks the storage backend. Production uses Upstash Redis through its REST API (Vercel's Upstash/KV
// integration injects these variables). Without them we fall back to memory, which is only suitable for
// local development: serverless instances do not share memory.
import { memoryStore, type Store } from './handler';

function upstash(url: string, token: string): Store {
  const cmd = async (args: (string | number)[]): Promise<unknown> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    if (!res.ok) throw new Error(`Upstash ${res.status}`);
    return ((await res.json()) as { result: unknown }).result;
  };
  return {
    async get(key) { return ((await cmd(['GET', key])) as string | null) ?? null; },
    async set(key, value, ttl) { await cmd(['SET', key, value, 'EX', ttl]); },
    async del(key) { await cmd(['DEL', key]); },
    async incr(key, ttl) {
      const n = Number(await cmd(['INCR', key]));
      if (n === 1) await cmd(['EXPIRE', key, ttl]);
      return n;
    }
  };
}

let cached: Store | undefined;
export function getStore(): Store {
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  cached = url && token ? upstash(url, token) : memoryStore();
  return cached;
}

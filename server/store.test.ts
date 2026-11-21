import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickStore, upstash } from './store';

describe('pickStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses Redis when either variable naming scheme is present', () => {
    expect(pickStore({ UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' }).kind).toBe('redis');
    expect(pickStore({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't', VERCEL: '1' }).kind).toBe('redis');
  });

  it('refuses to fall back to memory on Vercel, and says why in the logs', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(pickStore({ VERCEL: '1' }).kind).toBe('unconfigured');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('NOT configured'));
    // half-configured is still unconfigured
    expect(pickStore({ VERCEL: '1', KV_REST_API_URL: 'https://x' }).kind).toBe('unconfigured');
  });

  it('allows memory locally, or on Vercel only when asked for explicitly', () => {
    expect(pickStore({}).kind).toBe('memory');
    expect(pickStore({ VERCEL: '1', ALLOW_MEMORY_STORE: '1' }).kind).toBe('memory');
  });
});

describe('upstash store', () => {
  it('creates a counter with its expiry first, then increments (no immortal counters)', async () => {
    const calls: unknown[][] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      const args = JSON.parse(String(init.body)) as unknown[];
      calls.push(args);
      return { ok: true, json: async () => ({ result: args[0] === 'INCR' ? 7 : 'OK' }) } as Response;
    }) as unknown as typeof fetch;
    const store = upstash('https://redis.example', 'tok', fake);
    expect(await store.incr('rl:x', 3600)).toBe(7);
    expect(calls).toEqual([['SET', 'rl:x', 0, 'EX', 3600, 'NX'], ['INCR', 'rl:x']]);
  });

  it('turns an HTTP error into an exception (the API answers 500, not 404)', async () => {
    const fake = (async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(upstash('https://redis.example', 'tok', fake).get('k')).rejects.toThrow('Upstash 502');
  });
});

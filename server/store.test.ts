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
    expect(pickStore({ VERCEL: '1', ALLOW_MEMORY_STORE: '0' }).kind).toBe('unconfigured');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('NOT configured'));
    // half-configured is still unconfigured
    expect(pickStore({ VERCEL: '1', ALLOW_MEMORY_STORE: '0', KV_REST_API_URL: 'https://x' }).kind).toBe('unconfigured');
  });

  it('allows memory locally, or on Vercel only when asked for explicitly', () => {
    expect(pickStore({}).kind).toBe('memory');
    expect(pickStore({ VERCEL: '1', ALLOW_MEMORY_STORE: '1' }).kind).toBe('memory');
    // default on Vercel without Redis: temporary memory (works for a while), with a warning in the logs
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(pickStore({ VERCEL: '1' }).kind).toBe('memory');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('temporary memory'));
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

describe('compare-and-set', () => {
  it('memory store: setIf/delIf only act on the expected value', async () => {
    const { memoryStore } = await import('./handler');
    const m = memoryStore();
    expect(await m.setIf('k', 'v1', 60, null)).toBe(true);
    expect(await m.setIf('k', 'v2', 60, null)).toBe(false);   // must not exist
    expect(await m.setIf('k', 'v2', 60, 'zzz')).toBe(false);  // wrong expected
    expect(await m.setIf('k', 'v2', 60, 'v1')).toBe(true);
    expect(await m.get('k')).toBe('v2');
    expect(await m.delIf('k', 'v1')).toBe(false);
    expect(await m.delIf('k', 'v2')).toBe(true);
    expect(await m.get('k')).toBeNull();
  });

  it('redis store: sends one atomic EVAL per compare-and-set and reads the 1/0 result', async () => {
    const calls: unknown[][] = [];
    const fake = (async (_u: string, init: RequestInit) => {
      const args = JSON.parse(String(init.body)) as unknown[];
      calls.push(args);
      return { ok: true, json: async () => ({ result: 1 }) } as Response;
    }) as unknown as typeof fetch;
    const r = upstash('https://redis.example', 't', fake);
    expect(await r.setIf('share:A', '{"a":1}', 604800, null)).toBe(true);
    expect(await r.setIf('share:A', '{"a":2}', 604800, '{"a":1}')).toBe(true);
    expect(await r.delIf('share:A', '{"a":2}')).toBe(true);
    expect(calls[0].slice(0, 3)).toEqual(['EVAL', expect.stringContaining("redis.call('SET'"), 1]);
    expect(calls[0].slice(3)).toEqual(['share:A', '', '{"a":1}', 604800]);          // '' = "must not exist"
    expect(calls[1].slice(3)).toEqual(['share:A', '{"a":1}', '{"a":2}', 604800]);
    expect(calls[2].slice(3)).toEqual(['share:A', '{"a":2}']);
    const lost = (async () => ({ ok: true, json: async () => ({ result: 0 }) }) as unknown as Response) as unknown as typeof fetch;
    expect(await upstash('https://redis.example', 't', lost).setIf('k', 'v', 60, 'x')).toBe(false);
  });
});

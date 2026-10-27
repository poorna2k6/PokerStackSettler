import { describe, expect, it } from 'vitest';
import { handleShare, memoryStore, type ApiRequest } from './handler';

const players = [
  { id: 'a', name: 'Ann', buyInCents: 10000, cashOutCents: 15000 },
  { id: 'b', name: 'Bob', buyInCents: 10000, cashOutCents: 5000 }
];
const snap = (over: Record<string, unknown> = {}) => ({ name: 'Fri', defaultBuyIn: 100, expenseCents: 0, isEnded: false, players, paid: {}, ...over });

let ip = 0;
const req = (method: string, o: Partial<ApiRequest> = {}): ApiRequest =>
  ({ method, query: {}, headers: {}, body: null, ip: `1.1.1.${ip}`, ...o });

function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const store = memoryStore(clock.now);
  ip++;
  const call = (r: ApiRequest) => handleShare(r, store, clock.now());
  return { store, clock, call };
}

async function create(call: ReturnType<typeof setup>['call'], body = { snapshot: snap() }) {
  const res = await call(req('POST', { body }));
  return { res, data: res.body as { code: string; hostKey: string; rev: number } };
}

describe('create', () => {
  it('returns a code and a secret host key, and stores only a hash of the key', async () => {
    const { store, call } = setup();
    const { res, data } = await create(call);
    expect(res.status).toBe(201);
    expect(data.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(data.hostKey.length).toBeGreaterThanOrEqual(30);
    const stored = (await store.get(`share:${data.code}`))!;
    expect(stored).not.toContain(data.hostKey);
  });

  it('rejects garbage and sanitizes hostile content', async () => {
    const { call } = setup();
    expect((await call(req('POST', { body: { snapshot: 'x' } }))).status).toBe(400);
    expect((await call(req('POST', { body: {} }))).status).toBe(400);
    const { data } = await create(call, { snapshot: snap({ name: 'x'.repeat(500), players: [{ id: '<b>', name: '<img src=x onerror=1>', buyInCents: -5, cashOutCents: 1e15 }] }) });
    const got = await call(req('GET', { query: { code: data.code } }));
    const s = (got.body as { snapshot: { name: string; players: { buyInCents: number; cashOutCents: number }[] } }).snapshot;
    expect(s.name.length).toBe(80);
    expect(s.players[0].buyInCents).toBe(0);
    expect(s.players[0].cashOutCents).toBeLessThanOrEqual(100_000_000);
  });

  it('rate limits creation per IP', async () => {
    const { call } = setup();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call(req('POST', { body: { snapshot: snap() } }))).status;
    expect(last).toBe(429);
  });
});

describe('who may read and who may write', () => {
  it('anyone with the code can read, never sees the key hash', async () => {
    const { call } = setup();
    const { data } = await create(call);
    const res = await call(req('GET', { query: { code: data.code.toLowerCase() }, ip: '9.9.9.9' }));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/keyHash|hostKey/);
    expect(res.headers?.['Cache-Control']).toBe('no-store');
  });

  it('only the host key can update or delete', async () => {
    const { call } = setup();
    const { data } = await create(call);
    const attempt = (key: string | undefined, method = 'PUT') =>
      call(req(method, { query: { code: data.code }, headers: key ? { 'x-host-key': key } : {}, body: { snapshot: snap({ name: 'Hacked' }) } }));
    expect((await attempt(undefined)).status).toBe(403);
    expect((await attempt('wrong')).status).toBe(403);
    expect((await attempt(data.code)).status).toBe(403); // the view code is not the host key
    expect((await attempt('x'.repeat(500))).status).toBe(403);
    expect((await attempt(undefined, 'DELETE')).status).toBe(403);
    const still = await call(req('GET', { query: { code: data.code } }));
    expect((still.body as { snapshot: { name: string } }).snapshot.name).toBe('Fri');
    expect((await attempt(data.hostKey)).status).toBe(200);
    const after = await call(req('GET', { query: { code: data.code } }));
    expect((after.body as { snapshot: { name: string } }).snapshot.name).toBe('Hacked');
  });

  it('bumps the revision and answers "unchanged" cheaply', async () => {
    const { call } = setup();
    const { data } = await create(call);
    const put = await call(req('PUT', { query: { code: data.code }, headers: { 'x-host-key': data.hostKey }, body: { snapshot: snap() } }));
    expect((put.body as { rev: number }).rev).toBe(2);
    const same = await call(req('GET', { query: { code: data.code, since: '2' } }));
    expect(same.body).toEqual({ unchanged: true, rev: 2 });
    const stale = await call(req('GET', { query: { code: data.code, since: '1' } }));
    expect((stale.body as { snapshot?: unknown }).snapshot).toBeTruthy();
  });

  it('host can stop sharing; the link then 404s', async () => {
    const { call } = setup();
    const { data } = await create(call);
    expect((await call(req('DELETE', { query: { code: data.code }, headers: { 'x-host-key': data.hostKey } }))).status).toBe(200);
    expect((await call(req('GET', { query: { code: data.code } }))).status).toBe(404);
  });

  it('rejects malformed codes and unsupported methods', async () => {
    const { call } = setup();
    expect((await call(req('GET', { query: { code: 'abc' } }))).status).toBe(400);
    expect((await call(req('GET', { query: { code: 'O0I1O0I1' } }))).status).toBe(400);
    expect((await call(req('PATCH', { query: { code: 'ABCDEFGH' } }))).status).toBe(405);
  });
});

describe('expiry and abuse limits', () => {
  it('expires 7 days after the last host edit (rolling), not after reads', async () => {
    const { call, clock } = setup();
    const { data } = await create(call);
    const day = 24 * 3600 * 1000;
    clock.advance(6 * day);
    expect((await call(req('GET', { query: { code: data.code } }))).status).toBe(200); // reading does not extend
    await call(req('PUT', { query: { code: data.code }, headers: { 'x-host-key': data.hostKey }, body: { snapshot: snap() } }));
    clock.advance(6 * day);
    expect((await call(req('GET', { query: { code: data.code } }))).status).toBe(200); // the host edit extended it
    clock.advance(2 * day);
    expect((await call(req('GET', { query: { code: data.code } }))).status).toBe(404);
    const dead = await call(req('PUT', { query: { code: data.code }, headers: { 'x-host-key': data.hostKey }, body: { snapshot: snap() } }));
    expect(dead.status).toBe(404);
  });

  it('throttles code guessing per IP', async () => {
    const { call } = setup();
    let last = 0;
    for (let i = 0; i < 45; i++) last = (await call(req('GET', { query: { code: 'ABCDEFGH' } }))).status;
    expect(last).toBe(429);
    // another IP is unaffected
    expect((await call(req('GET', { query: { code: 'ABCDEFGH' }, ip: '8.8.8.8' }))).status).toBe(404);
  });

  it('survives a corrupt record', async () => {
    const { call, store } = setup();
    await store.set('share:ABCDEFGH', '{not json', 60);
    expect((await call(req('GET', { query: { code: 'ABCDEFGH' } }))).status).toBe(404);
  });
});

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

  it('honours a host-chosen lifetime, only from the allowed list', async () => {
    const { call, clock } = setup();
    const day = 24 * 3600 * 1000;
    const short = (await create(call, { snapshot: snap(), ttlSeconds: 24 * 3600 } as never)).data;
    expect(short.ttl).toBe(86400);
    const bad = (await create(call, { snapshot: snap(), ttlSeconds: 99999999999 } as never)).data; // not allowed -> default 7 days
    expect(bad.ttl).toBe(7 * 86400);
    const long = (await create(call, { snapshot: snap(), ttlSeconds: 90 * 86400 } as never)).data;
    clock.advance(2 * day);
    expect((await call(req('GET', { query: { code: short.code } }))).status).toBe(404);
    expect((await call(req('GET', { query: { code: bad.code } }))).status).toBe(200);
    clock.advance(10 * day);
    expect((await call(req('GET', { query: { code: bad.code } }))).status).toBe(404);
    expect((await call(req('GET', { query: { code: long.code } }))).status).toBe(200);
  });

  it('lets only the host change the lifetime, and keeps it across edits and hand-over', async () => {
    const { call } = setup();
    const { data } = await create(call);
    const put = (key: string, ttlSeconds?: number) => call(req('PUT', { query: { code: data.code }, headers: { 'x-host-key': key }, body: { snapshot: snap(), ttlSeconds } }));
    expect((await put('wrong', 30 * 86400)).status).toBe(403);
    const r = await put(data.hostKey, 30 * 86400);
    expect((r.body as { ttl: number }).ttl).toBe(30 * 86400);
    const again = await put(data.hostKey); // no ttl sent: kept
    expect((again.body as { ttl: number }).ttl).toBe(30 * 86400);
    const junk = await put(data.hostKey, 5); // not allowed: kept
    expect((junk.body as { ttl: number }).ttl).toBe(30 * 86400);
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

// ---------------------------------------------------------------------------------------------
// Hand-over: moving the host role to someone else
// ---------------------------------------------------------------------------------------------
import { createHash } from 'node:crypto';

const hashOf = (k: string) => createHash('sha256').update(k).digest('hex');

describe('hand-over', () => {
  const newKey = 'n'.repeat(32);
  const act = (call: ReturnType<typeof setup>['call'], code: string, action: string, method: string, o: Partial<ApiRequest> = {}) =>
    call(req(method, { query: { code, action }, ...o }));
  const hostHdr = (k: string) => ({ 'x-host-key': k });

  async function seatOffer(env: ReturnType<typeof setup>, data: { code: string; hostKey: string }, playerId = 'b') {
    return act(env.call, data.code, 'offer', 'POST', { headers: hostHdr(data.hostKey), body: { kind: 'seat', playerId } });
  }
  const getRec = async (call: ReturnType<typeof setup>['call'], code: string) =>
    (await call(req('GET', { query: { code }, ip: '7.7.7.7' }))).body as { offer?: { kind: string; playerId?: string; status: string }; epoch: number; snapshot: { name: string }; rev: number };

  it('only the host can open, withdraw, approve or verify', async () => {
    const env = setup();
    const { data } = await create(env.call);
    for (const [action, method, body] of [['offer', 'POST', { kind: 'link' }], ['offer', 'DELETE', {}], ['approve', 'POST', { approve: true }], ['verify', 'POST', {}]] as const) {
      expect((await act(env.call, data.code, action, method, { body })).status).toBe(403);
      expect((await act(env.call, data.code, action, method, { body, headers: hostHdr('nope') })).status).toBe(403);
      expect((await act(env.call, data.code, action, method, { body, headers: hostHdr(data.code) })).status).toBe(403);
    }
    expect((await act(env.call, data.code, 'verify', 'POST', { headers: hostHdr(data.hostKey) })).status).toBe(200);
  });

  describe('offer to a player in the list', () => {
    it('is visible to viewers without any secret, and rejects unknown players', async () => {
      const env = setup();
      const { data } = await create(env.call);
      expect((await seatOffer(env, data, 'ghost')).status).toBe(400);
      const res = await seatOffer(env, data);
      expect(res.status).toBe(201);
      const view = await getRec(env.call, data.code);
      expect(view.offer).toMatchObject({ kind: 'seat', playerId: 'b', status: 'open' });
      const raw = JSON.stringify(await env.call(req('GET', { query: { code: data.code }, ip: '7.7.7.8' })));
      expect(raw).not.toMatch(/keyHash|tokenHash|hostKey/);
    });

    it('needs the host to confirm: claim alone gives the claimant nothing', async () => {
      const env = setup();
      const { data } = await create(env.call);
      await seatOffer(env, data);
      const claim = await act(env.call, data.code, 'claim', 'POST', { body: { keyHash: hashOf(newKey) }, ip: '9.9.9.9' });
      expect(claim.status).toBe(200);
      expect((await getRec(env.call, data.code)).offer?.status).toBe('claimed');
      // the claimant's key is not valid yet, the old host key still is
      expect((await act(env.call, data.code, 'verify', 'POST', { headers: hostHdr(newKey) })).status).toBe(403);
      expect((await act(env.call, data.code, 'verify', 'POST', { headers: hostHdr(data.hostKey) })).status).toBe(200);
      // the claimant cannot approve themselves
      expect((await act(env.call, data.code, 'approve', 'POST', { body: { approve: true }, headers: hostHdr(newKey) })).status).toBe(403);
    });

    it('a second claimant is refused while one is waiting; host can decline and the offer reopens', async () => {
      const env = setup();
      const { data } = await create(env.call);
      await seatOffer(env, data);
      await act(env.call, data.code, 'claim', 'POST', { body: { keyHash: hashOf(newKey) } });
      expect((await act(env.call, data.code, 'claim', 'POST', { body: { keyHash: hashOf('x'.repeat(32)) } })).status).toBe(409);
      const dec = await act(env.call, data.code, 'approve', 'POST', { body: { approve: false }, headers: hostHdr(data.hostKey) });
      expect(dec.body).toMatchObject({ ok: true, declined: true });
      expect((await getRec(env.call, data.code)).offer?.status).toBe('open');
      expect((await act(env.call, data.code, 'claim', 'POST', { body: { keyHash: hashOf('x'.repeat(32)) } })).status).toBe(200);
    });

    it('approval rotates the key: old host locked out at once, new host works, viewers keep the same link', async () => {
      const env = setup();
      const { data } = await create(env.call);
      await seatOffer(env, data);
      await act(env.call, data.code, 'claim', 'POST', { body: { keyHash: hashOf(newKey) } });
      const ok = await act(env.call, data.code, 'approve', 'POST', { body: { approve: true }, headers: hostHdr(data.hostKey) });
      expect(ok.status).toBe(200);
      const after = await getRec(env.call, data.code);
      expect(after.offer).toBeUndefined();
      expect(after.epoch).toBe(2);
      expect(after.snapshot.name).toBe('Fri');
      const put = (k: string) => env.call(req('PUT', { query: { code: data.code }, headers: hostHdr(k), body: { snapshot: snap({ name: 'By new host' }) } }));
      expect((await put(data.hostKey)).status).toBe(403);
      expect((await put(newKey)).status).toBe(200);
      expect((await getRec(env.call, data.code)).snapshot.name).toBe('By new host');
    });

    it('approve without a claim is refused', async () => {
      const env = setup();
      const { data } = await create(env.call);
      expect((await act(env.call, data.code, 'approve', 'POST', { body: { approve: true }, headers: hostHdr(data.hostKey) })).status).toBe(409);
      await seatOffer(env, data);
      expect((await act(env.call, data.code, 'approve', 'POST', { body: { approve: true }, headers: hostHdr(data.hostKey) })).status).toBe(409);
    });
  });

  describe('one-time link / QR for anyone', () => {
    async function linkOffer(env: ReturnType<typeof setup>, data: { code: string; hostKey: string }) {
      const res = await act(env.call, data.code, 'offer', 'POST', { headers: hostHdr(data.hostKey), body: { kind: 'link' } });
      return { res, token: (res.body as { token: string }).token };
    }

    it('returns the token once to the host and never to viewers', async () => {
      const env = setup();
      const { data } = await create(env.call);
      const { res, token } = await linkOffer(env, data);
      expect(res.status).toBe(201);
      expect(token.length).toBeGreaterThanOrEqual(20);
      const viewerSees = JSON.stringify((await env.call(req('GET', { query: { code: data.code }, ip: '6.6.6.6' }))).body);
      expect(viewerSees).not.toContain(token);
      expect(viewerSees).not.toMatch(/tokenHash|keyHash/);
      expect(JSON.parse(viewerSees).offer).toMatchObject({ kind: 'link', status: 'open' });
    });

    it('rejects a wrong or missing token and bad key hashes without changing anything', async () => {
      const env = setup();
      const { data } = await create(env.call);
      const { token } = await linkOffer(env, data);
      const claim = (body: Record<string, unknown>) => act(env.call, data.code, 'claim', 'POST', { body });
      expect((await claim({ keyHash: hashOf(newKey) })).status).toBe(403);
      expect((await claim({ token: 'wrong', keyHash: hashOf(newKey) })).status).toBe(403);
      expect((await claim({ token: token + 'x', keyHash: hashOf(newKey) })).status).toBe(403);
      expect((await claim({ token, keyHash: 'short' })).status).toBe(400);
      expect((await claim({ token, keyHash: 'Z'.repeat(64) })).status).toBe(400);
      expect((await act(env.call, data.code, 'verify', 'POST', { headers: hostHdr(data.hostKey) })).status).toBe(200); // host unchanged
    });

    it('the token works once: the claimant becomes host, the old host is locked out, the link is dead', async () => {
      const env = setup();
      const { data } = await create(env.call);
      const { token } = await linkOffer(env, data);
      const ok = await act(env.call, data.code, 'claim', 'POST', { body: { token, keyHash: hashOf(newKey) }, ip: '5.5.5.5' });
      expect(ok.status).toBe(200);
      expect((ok.body as { snapshot: { name: string } }).snapshot.name).toBe('Fri');
      expect((await act(env.call, data.code, 'verify', 'POST', { headers: hostHdr(data.hostKey) })).status).toBe(403);
      expect((await act(env.call, data.code, 'verify', 'POST', { headers: hostHdr(newKey) })).status).toBe(200);
      // replay with the same token
      expect((await act(env.call, data.code, 'claim', 'POST', { body: { token, keyHash: hashOf('r'.repeat(32)) } })).status).toBe(404);
      expect((await getRec(env.call, data.code)).epoch).toBe(2);
    });

    it('expires after 10 minutes', async () => {
      const env = setup();
      const { data } = await create(env.call);
      const { token } = await linkOffer(env, data);
      env.clock.advance(10 * 60 * 1000 + 1000);
      expect((await act(env.call, data.code, 'claim', 'POST', { body: { token, keyHash: hashOf(newKey) } })).status).toBe(404);
      expect((await getRec(env.call, data.code)).offer).toBeUndefined();
    });

    it('a new offer replaces the old one (old token stops working); the host can withdraw it', async () => {
      const env = setup();
      const { data } = await create(env.call);
      const first = await linkOffer(env, data);
      const second = await linkOffer(env, data);
      expect((await act(env.call, data.code, 'claim', 'POST', { body: { token: first.token, keyHash: hashOf(newKey) } })).status).toBe(403);
      expect((await act(env.call, data.code, 'offer', 'DELETE', { headers: hostHdr(data.hostKey) })).status).toBe(200);
      expect((await act(env.call, data.code, 'claim', 'POST', { body: { token: second.token, keyHash: hashOf(newKey) } })).status).toBe(404);
    });

    it('throttles only failed guesses, per IP: a bystander cannot lock the host out, a valid token always works', async () => {
      const env = setup();
      const { data } = await create(env.call);
      const { token } = await linkOffer(env, data);
      let last = 0;
      for (let i = 0; i < 60; i++) {
        last = (await act(env.call, data.code, 'claim', 'POST', { body: { token: `guess${i}`, keyHash: hashOf(newKey) }, ip: '66.6.6.6' })).status;
      }
      expect(last).toBe(429);                                   // the noisy IP is throttled...
      for (let i = 0; i < 80; i++) {                             // ...and other people's noise does not consume anything shared
        await act(env.call, data.code, 'claim', 'POST', { body: { token: `x${i}`, keyHash: hashOf(newKey) }, ip: `77.7.${i % 200}.1` });
      }
      // the host's real QR still works, from a fresh IP and even from the throttled one
      const ok = await act(env.call, data.code, 'claim', 'POST', { body: { token, keyHash: hashOf(newKey) }, ip: '66.6.6.6' });
      expect(ok.status).toBe(200);
    });
  });

  it('host pushes keep an open offer; unknown actions and methods are refused', async () => {
    const env = setup();
    const { data } = await create(env.call);
    await seatOffer(env, data);
    await env.call(req('PUT', { query: { code: data.code }, headers: hostHdr(data.hostKey), body: { snapshot: snap({ name: 'Edited' }) } }));
    expect((await getRec(env.call, data.code)).offer?.status).toBe('open');
    expect((await act(env.call, data.code, 'frobnicate', 'POST', { headers: hostHdr(data.hostKey) })).status).toBe(400);
    expect((await act(env.call, data.code, 'claim', 'GET')).status).toBe(405);
    expect((await act(env.call, data.code, 'verify', 'GET', { headers: hostHdr(data.hostKey) })).status).toBe(405);
  });
});

// ---------------------------------------------------------------------------------------------
// Expiry hardening
// ---------------------------------------------------------------------------------------------
import { StorageNotConfigured, type Store } from './handler';

describe('expiry reasons and honest expiry time', () => {
  const DAY = 24 * 3600 * 1000;

  it('a stopped table says "stopped", an unknown or expired one says "expired_or_unknown"', async () => {
    const env = setup();
    const { data } = await create(env.call);
    await env.call(req('DELETE', { query: { code: data.code }, headers: { 'x-host-key': data.hostKey } }));
    const stopped = await env.call(req('GET', { query: { code: data.code }, ip: '3.3.3.3' }));
    expect(stopped.status).toBe(404);
    expect((stopped.body as { reason: string }).reason).toBe('stopped');
    const unknown = await env.call(req('GET', { query: { code: 'ZZZZZZZZ' }, ip: '3.3.3.4' }));
    expect((unknown.body as { reason: string }).reason).toBe('expired_or_unknown');

    const e2 = setup();
    const c2 = await create(e2.call);
    e2.clock.advance(8 * DAY);
    const expired = await e2.call(req('GET', { query: { code: c2.data.code }, ip: '3.3.3.5' }));
    expect(expired.status).toBe(404);
    expect((expired.body as { reason: string }).reason).toBe('expired_or_unknown');
  });

  it('looking up a stopped table does not use up the code-guessing budget', async () => {
    const env = setup();
    const { data } = await create(env.call);
    await env.call(req('DELETE', { query: { code: data.code }, headers: { 'x-host-key': data.hostKey } }));
    let last = 0;
    for (let i = 0; i < 60; i++) last = (await env.call(req('GET', { query: { code: data.code }, ip: '4.4.4.4' }))).status;
    expect(last).toBe(404); // never 429
  });

  it('reports the real expiry, including after hand-over writes that refresh the stored lifetime', async () => {
    const env = setup();
    const { data } = await create(env.call);
    env.clock.advance(3 * DAY);
    await env.call(req('POST', { query: { code: data.code, action: 'offer' }, headers: { 'x-host-key': data.hostKey }, body: { kind: 'link' } }));
    const view = await env.call(req('GET', { query: { code: data.code }, ip: '5.5.5.5' }));
    const exp = (view.body as { expiresAt: number }).expiresAt;
    expect(exp).toBe(env.clock.now() + 7 * DAY); // used to understate it (3 days too early)
    // and the store really keeps it that long
    env.clock.advance(6 * DAY);
    expect((await env.call(req('GET', { query: { code: data.code }, ip: '5.5.5.6' }))).status).toBe(200);
  });
});

describe('storage health and the unconfigured store', () => {
  const unconfigured: Store = {
    kind: 'unconfigured',
    get: async () => { throw new StorageNotConfigured(); },
    set: async () => { throw new StorageNotConfigured(); },
    del: async () => { throw new StorageNotConfigured(); },
    setIf: async () => { throw new StorageNotConfigured(); },
    delIf: async () => { throw new StorageNotConfigured(); },
    incr: async () => { throw new StorageNotConfigured(); }
  };

  it('health reports the backend; without one every call is a clear 503, not a random 404', async () => {
    const ok = await handleShare(req('GET', { query: { action: 'health' } }), memoryStore());
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, store: 'memory' });

    const health = await handleShare(req('GET', { query: { action: 'health' } }), unconfigured);
    expect(health.status).toBe(503);
    expect(health.body).toMatchObject({ reason: 'storage_not_configured' });
    for (const r of [req('POST', { body: { snapshot: snap() } }), req('GET', { query: { code: 'ABCDEFGH' } }), req('PUT', { query: { code: 'ABCDEFGH' } })]) {
      const res = await handleShare(r, unconfigured);
      expect(res.status).toBe(503);
      expect((res.body as { reason: string }).reason).toBe('storage_not_configured');
    }
  });

  it('documents the failure mode the unconfigured store prevents: two memory instances disagree', async () => {
    const a = memoryStore();
    const b = memoryStore();
    const made = await handleShare(req('POST', { body: { snapshot: snap() } }), a);
    const code = (made.body as { code: string }).code;
    expect((await handleShare(req('GET', { query: { code }, ip: '8.1.1.1' }), a)).status).toBe(200);
    expect((await handleShare(req('GET', { query: { code }, ip: '8.1.1.2' }), b)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
// Concurrency: the real production store has latency between read and write
// ---------------------------------------------------------------------------------------------
describe('atomic hand-over under concurrent requests', () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  /** A store whose reads take a moment, like a network call, so concurrent requests interleave. */
  function slow(inner: Store): Store {
    return {
      kind: inner.kind,
      get: async k => { const v = await inner.get(k); await sleep(Math.random() * 6); return v; },
      set: inner.set, del: inner.del, setIf: inner.setIf, delIf: inner.delIf, incr: inner.incr
    };
  }
  const mk = () => {
    const inner = memoryStore();
    const store = slow(inner);
    const call = (r: ApiRequest) => handleShare(r, store, Date.now());
    return { call };
  };
  const key2 = 'm'.repeat(32);

  it('two phones using the same QR at the same moment: exactly one wins and exactly one key is valid', async () => {
    for (let round = 0; round < 15; round++) {
      const { call } = mk();
      ip++;
      const made = (await call(req('POST', { body: { snapshot: snap() } }))).body as { code: string; hostKey: string };
      const off = (await call(req('POST', { query: { code: made.code, action: 'offer' }, headers: { 'x-host-key': made.hostKey }, body: { kind: 'link' } }))).body as { token: string };
      const [a, b] = await Promise.all([
        call(req('POST', { query: { code: made.code, action: 'claim' }, body: { token: off.token, keyHash: hashOf(newKeyA) }, ip: '1.2.3.4' })),
        call(req('POST', { query: { code: made.code, action: 'claim' }, body: { token: off.token, keyHash: hashOf(key2) }, ip: '1.2.3.5' }))
      ]);
      const wins = [a.status, b.status].filter(x => x === 200).length;
      expect(wins).toBe(1);
      const valid = async (k: string) => (await call(req('POST', { query: { code: made.code, action: 'verify' }, headers: { 'x-host-key': k } }))).status === 200;
      const states = [await valid(made.hostKey), await valid(newKeyA), await valid(key2)];
      expect(states.filter(Boolean).length).toBe(1);
      expect(states[0]).toBe(false); // the old host is out
      expect(states[a.status === 200 ? 1 : 2]).toBe(true);
    }
  });

  it('a stale save from the old host racing a hand-over can never bring the old key back', async () => {
    for (let round = 0; round < 20; round++) {
      const { call } = mk();
      ip++;
      const made = (await call(req('POST', { body: { snapshot: snap() } }))).body as { code: string; hostKey: string };
      const off = (await call(req('POST', { query: { code: made.code, action: 'offer' }, headers: { 'x-host-key': made.hostKey }, body: { kind: 'link' } }))).body as { token: string };
      const [put, claim] = await Promise.all([
        call(req('PUT', { query: { code: made.code }, headers: { 'x-host-key': made.hostKey }, body: { snapshot: snap({ name: `edit${round}` }) } })),
        call(req('POST', { query: { code: made.code, action: 'claim' }, body: { token: off.token, keyHash: hashOf(newKeyA) }, ip: '2.2.2.2' }))
      ]);
      expect(claim.status).toBe(200);
      const verify = async (k: string) => (await call(req('POST', { query: { code: made.code, action: 'verify' }, headers: { 'x-host-key': k } }))).status;
      expect(await verify(newKeyA)).toBe(200);  // the new host really is host (used to fail ~15% of the time)
      expect(await verify(made.hostKey)).toBe(403);
      expect([200, 403]).toContain(put.status);
    }
  });

  it('host stopping the table while a claim lands cannot leave a half-deleted table', async () => {
    for (let round = 0; round < 10; round++) {
      const { call } = mk();
      ip++;
      const made = (await call(req('POST', { body: { snapshot: snap() } }))).body as { code: string; hostKey: string };
      const off = (await call(req('POST', { query: { code: made.code, action: 'offer' }, headers: { 'x-host-key': made.hostKey }, body: { kind: 'link' } }))).body as { token: string };
      const [del, claim] = await Promise.all([
        call(req('DELETE', { query: { code: made.code }, headers: { 'x-host-key': made.hostKey } })),
        call(req('POST', { query: { code: made.code, action: 'claim' }, body: { token: off.token, keyHash: hashOf(newKeyA) }, ip: '3.3.3.3' }))
      ]);
      const view = await call(req('GET', { query: { code: made.code }, ip: '4.4.4.4' }));
      if (del.status === 200) expect(view.status).toBe(404);           // stopped means stopped
      else expect(view.status).toBe(200);                                // the claim won, the old host's stop was refused
      expect([200, 403, 404]).toContain(claim.status);
    }
  });
});
const newKeyA = 'a'.repeat(32);

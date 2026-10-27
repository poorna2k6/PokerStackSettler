// Runs the generated api/share.js exactly the way Vercel does (plain Node ESM, no TypeScript),
// so a broken bundle or a missing build step fails here instead of in production.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<void>;
let server: ReturnType<typeof createServer>;
let base = '';

beforeAll(async () => {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(resolve('api/share.js')).href)) as { default: Handler };
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    // Vercel hands functions an already-parsed JSON body
    (req as unknown as { body: unknown }).body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    await mod.default(req, res);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/share`;
});
afterAll(() => { server.close(); });

const snapshot = { name: 'Bundle test', defaultBuyIn: 100, expenseCents: 0, isEnded: false, paid: {},
  players: [{ id: 'a', name: 'Ann', buyInCents: 10000, cashOutCents: 10000 }] };

describe('generated api/share.js', () => {
  it('create -> read -> host-only update -> delete', async () => {
    const created = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot }) });
    expect(created.status).toBe(201);
    const { code, hostKey } = (await created.json()) as { code: string; hostKey: string };

    const read = await fetch(`${base}?code=${code}`);
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect(((await read.json()) as { snapshot: { name: string } }).snapshot.name).toBe('Bundle test');

    const body = JSON.stringify({ snapshot: { ...snapshot, name: 'Changed' } });
    const denied = await fetch(`${base}?code=${code}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
    expect(denied.status).toBe(403);
    const allowed = await fetch(`${base}?code=${code}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-host-key': hostKey }, body });
    expect(allowed.status).toBe(200);

    const del = await fetch(`${base}?code=${code}`, { method: 'DELETE', headers: { 'x-host-key': hostKey } });
    expect(del.status).toBe(200);
    expect((await fetch(`${base}?code=${code}`)).status).toBe(404);
  });

  it('rejects oversized payloads before parsing', async () => {
    const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot, pad: 'x'.repeat(40000) }) });
    expect(res.status).toBe(413);
  });
});

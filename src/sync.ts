// Host side of live sharing. The host's device stays the single source of truth and the only writer:
// it pushes snapshots to /api/share using a secret host key that never leaves this device.
import { toast } from './dom';
import { normalizeCode, type SharedSnapshot } from './shared';
import { notify, onCommit, onShareOrphaned, setShare, shareSnapshot, state } from './state';

const API = '/api/share';
const PUSH_DELAY_MS = 600;
const RETRY_MS = 15000;

export type SyncPhase = 'off' | 'syncing' | 'ok' | 'offline' | 'expired';
export const sync: { phase: SyncPhase; at: string } = { phase: 'off', at: '' };

function setPhase(phase: SyncPhase, at = sync.at) {
  if (sync.phase === phase && sync.at === at) return;
  sync.phase = phase;
  sync.at = at;
  notify();
}

const clock = () => new Date().toTimeString().slice(0, 8);

interface Reply<T> { status: number; data: T }

async function call<T>(method: string, query: string, body?: unknown, hostKey?: string): Promise<Reply<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${API}${query}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(hostKey ? { 'x-host-key': hostKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    });
    let data: unknown = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data: data as T };
  } finally {
    clearTimeout(timer);
  }
}

export const shareUrl = (code: string) => `${location.origin}${location.pathname}#/v/${code}`;

export async function startSharing(): Promise<string | null> {
  if (state.session.isDemo) return 'Demo data can’t be shared — start a fresh session first.';
  try {
    const r = await call<{ code: string; hostKey: string; error?: string }>('POST', '', { snapshot: shareSnapshot() });
    if (r.status !== 201 || !normalizeCode(r.data?.code)) return r.data?.error ?? 'Could not start sharing. Check your connection and try again.';
    setShare({ code: r.data.code, hostKey: r.data.hostKey });
    setPhase('ok', clock());
    return null;
  } catch {
    return 'Could not reach the server. Check your connection and try again.';
  }
}

/** Stops the link for everyone. Returns false if the server could not be told (the link then expires on its own). */
export async function stopSharing(): Promise<boolean> {
  const share = state.session.share;
  if (!share) return true;
  let confirmed = true;
  try {
    const r = await call('DELETE', `?code=${share.code}`, undefined, share.hostKey);
    confirmed = r.status === 200 || r.status === 404 || r.status === 403;
  } catch {
    confirmed = false;
  }
  setShare(undefined);
  setPhase('off', '');
  return confirmed;
}

// --- links that outlived their table ---------------------------------------------------------------
// Replacing the open table (new session, demo, open from History, restore) ends its live link. The stop
// request is remembered on this device until the server confirms, so the host key is never simply lost.
const PENDING_KEY = 'stacksettle_pending_stops_v1';
type Pending = { code: string; hostKey: string };

function readPending(): Pending[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is Pending => !!p && typeof p.code === 'string' && typeof p.hostKey === 'string').slice(0, 20);
  } catch { return []; }
}
function writePending(list: Pending[]) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(0, 20))); } catch { /* storage blocked */ }
}

let draining = false;
async function drainPendingStops() {
  if (draining) return;
  draining = true;
  try {
    for (const p of readPending()) {
      try {
        const r = await call('DELETE', `?code=${p.code}`, undefined, p.hostKey);
        // 200 stopped, 404 already gone, 403 not ours any more: all mean there is nothing left to stop
        if (r.status === 200 || r.status === 404 || r.status === 403) writePending(readPending().filter(x => x.code !== p.code));
      } catch { /* offline: keep it and try again later */ }
    }
  } finally {
    draining = false;
  }
}

onShareOrphaned(old => {
  writePending([...readPending().filter(p => p.code !== old.code), old]);
  setPhase('off', '');
  void drainPendingStops();
});

let timer: number | undefined;
let retryTimer: number | undefined;
let inFlight = false;
let dirty = false;

async function flush() {
  const share = state.session.share;
  if (!share || state.session.isDemo) { setPhase('off', ''); return; }
  if (inFlight) { dirty = true; return; }
  dirty = false;
  inFlight = true;
  try {
    const r = await call('PUT', `?code=${share.code}`, { snapshot: shareSnapshot() }, share.hostKey);
    if (r.status === 200) {
      setPhase('ok', clock());
    } else if (r.status === 404 || r.status === 403) {
      // expired (7 days without a host edit) or stopped elsewhere
      setShare(undefined);
      setPhase('expired', '');
      toast('Your live link expired — share again to get a new one', 'error');
    } else {
      throw new Error(String(r.status));
    }
  } catch {
    dirty = true;
    setPhase('offline');
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(flush, RETRY_MS);
  } finally {
    inFlight = false;
    if (dirty && sync.phase !== 'offline') schedule();
  }
}

function schedule() {
  if (!state.session.share || state.session.isDemo) {
    if (sync.phase !== 'off' && sync.phase !== 'expired') setPhase('off', '');
    return;
  }
  dirty = true;
  if (sync.phase === 'ok') setPhase('syncing');
  clearTimeout(timer);
  timer = window.setTimeout(flush, PUSH_DELAY_MS);
}

onCommit(schedule);
window.addEventListener('online', () => { void drainPendingStops(); if (state.session.share) { clearTimeout(retryTimer); void flush(); } });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session.share && sync.phase === 'offline') void flush();
});
void drainPendingStops();
// A session restored from storage that was being shared: push the current state (and refresh its 7 days).
if (state.session.share && !state.session.isDemo) { setPhase('syncing'); void flush(); }

export type { SharedSnapshot };

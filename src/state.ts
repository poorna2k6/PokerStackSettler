import {
  buildNotepad, parseBackup, parseBuyInUnit, reconcile, solve, toCents,
  type Player, type ReconcileMode, type SavedSession, type SessionData
} from './engine';
import { PRESETS, type Preset } from './presets';
import { loadLive, loadPrefs, loadTheme, loadVault, savePrefs, saveLive, saveTheme, saveVault, type Prefs, type Theme } from './storage';

export type Tab = 'table' | 'settle' | 'history' | 'settings';

export interface State {
  tab: Tab;
  theme: Theme;
  prefs: Prefs;
  session: SessionData;
  saved: SavedSession[];
  /** false when the browser refused to persist (private mode, quota, blocked storage) */
  storageOk: boolean;
  lastSave: string;
}

const uid = (p: string) =>
  `${p}_${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)}`;

function fromPreset(p: Preset): SessionData {
  return {
    id: uid('sess'),
    name: p.sessionName,
    defaultBuyIn: p.defaultBuyIn,
    expenseCents: p.expenseCents,
    isEnded: false,
    isDemo: true,
    players: p.players.map(x => ({ ...x, id: uid('p') })),
    paid: {}
  };
}

export const state: State = {
  tab: 'table',
  theme: loadTheme(),
  prefs: loadPrefs(),
  session: loadLive() ?? fromPreset(PRESETS[0]),
  saved: loadVault(),
  storageOk: true,
  lastSave: ''
};
// Probe storage once at startup so a blocked browser is flagged before the first edit.
state.storageOk = saveLive(state.session);

type Listener = () => void;
const listeners: Listener[] = [];
export const subscribe = (fn: Listener) => {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
};
/** Re-renders without counting as an edit (used for sync status changes). */
export const notify = () => listeners.forEach(fn => fn());
/** Hooks that run after every committed change to the session (e.g. live-share sync). */
const commitHooks: Listener[] = [];
export const onCommit = (fn: Listener) => commitHooks.push(fn);

const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export function commit() {
  state.storageOk = saveLive(state.session);
  state.lastSave = stamp().slice(11);
  commitHooks.forEach(fn => fn());
  listeners.forEach(fn => fn());
}

export const audit = () => solve(state.session.players, state.session.expenseCents, state.session.defaultBuyIn);
export { paidKey } from './engine';

export function setShare(share: SessionData['share']) {
  state.session.share = share;
  commit();
}

/** What viewers are allowed to see: the table itself, never the host key. */
export function shareSnapshot() {
  const s = state.session;
  return {
    name: s.name, defaultBuyIn: s.defaultBuyIn, expenseCents: s.expenseCents,
    isEnded: s.isEnded, players: s.players, paid: s.paid
  };
}

export function setTab(tab: Tab) { state.tab = tab; listeners.forEach(fn => fn()); }
export function setTheme(theme: Theme) { state.theme = theme; state.storageOk = saveTheme(theme) && state.storageOk; listeners.forEach(fn => fn()); }

export function setPrefs(patch: Partial<Prefs>) {
  state.prefs = { ...state.prefs, ...patch };
  state.storageOk = savePrefs(state.prefs) && state.storageOk;
  listeners.forEach(fn => fn());
}

export function setName(name: string) { state.session.name = name.trim().slice(0, 80) || 'Poker Session'; commit(); }
/** Returns false (and keeps the old unit) when the value is invalid. */
export function setUnit(v: string): boolean {
  const n = parseBuyInUnit(v);
  if (n !== null) state.session.defaultBuyIn = n;
  commit();
  return n !== null;
}
export function setExpense(v: string) { state.session.expenseCents = Math.max(0, toCents(v)); commit(); }

export function addPlayer(name: string, buyIns: number) {
  const unit = toCents(state.session.defaultBuyIn);
  state.session.players.push({
    id: uid('p'), name: name.trim().slice(0, 40) || `Player ${state.session.players.length + 1}`,
    buyInCents: Math.round(Math.max(0, buyIns) * unit), cashOutCents: 0
  });
  commit();
}
export function removePlayer(id: string) { state.session.players = state.session.players.filter(p => p.id !== id); commit(); }
export function updatePlayer(id: string, patch: Partial<Player>) {
  const p = state.session.players.find(x => x.id === id);
  if (p) Object.assign(p, patch);
  commit();
}
export function rebuy(id: string, delta: number) {
  const p = state.session.players.find(x => x.id === id);
  if (!p) return;
  p.buyInCents = Math.max(0, p.buyInCents + delta * toCents(state.session.defaultBuyIn));
  commit();
}

export function applyReconcile(mode: ReconcileMode) {
  state.session.players = reconcile(state.session.players, state.session.expenseCents, mode, state.session.defaultBuyIn);
  commit();
}

export function togglePaid(key: string) {
  if (state.session.paid[key]) delete state.session.paid[key]; else state.session.paid[key] = true;
  // keep the History copy of this session in step, so reopening it later shows the same paid marks
  const saved = state.saved.find(x => x.id === state.session.id);
  if (saved && !state.session.isDemo) {
    saved.paid = { ...state.session.paid };
    state.storageOk = saveVault(state.saved) && state.storageOk;
  }
  commit();
}

function snapshot(status: string): SavedSession {
  const s = state.session;
  return {
    id: s.id, name: s.name, timestamp: stamp(), status,
    defaultBuyIn: s.defaultBuyIn, expenseCents: s.expenseCents,
    players: s.players.map(p => ({ ...p })),
    paid: { ...s.paid }
  };
}

/** Demo sessions are never written to History. Returns null in that case. */
export function saveToHistory(status = 'Saved Snapshot'): SavedSession | null {
  if (state.session.isDemo) return null;
  const snap = snapshot(status);
  const i = state.saved.findIndex(x => x.id === snap.id);
  if (i >= 0) state.saved[i] = snap; else state.saved.unshift(snap);
  state.storageOk = saveVault(state.saved) && state.storageOk;
  commit();
  return snap;
}

/**
 * Locks the session; when chips don't match, balances them pro-rata first.
 * Returns false (and leaves the session open) if the table cannot be balanced,
 * e.g. the expense pot is larger than everything that was bought in.
 */
export function endSession(): boolean {
  if (!audit().isBalanced) {
    const s = state.session;
    const fixed = reconcile(s.players, s.expenseCents, 'proRataWinners', s.defaultBuyIn);
    // Only keep the adjustment if it actually balances; a refusal must not alter what the user typed.
    if (!solve(fixed, s.expenseCents, s.defaultBuyIn).isBalanced) return false;
    s.players = fixed;
  }
  state.session.isEnded = true;
  if (state.session.isDemo) commit(); else saveToHistory('Completed & Settled');
  return true;
}
export function reopenSession() { state.session.isEnded = false; commit(); }

export function newSession(p?: Preset) {
  state.session = p ? fromPreset(p) : {
    id: uid('sess'), name: 'New Poker Session', defaultBuyIn: 100, expenseCents: 0, isEnded: false, isDemo: false, players: [], paid: {}
  };
  state.tab = 'table';
  commit();
}

export function loadSaved(id: string) {
  const s = state.saved.find(x => x.id === id);
  if (!s) return;
  state.session = {
    id: s.id, name: s.name, defaultBuyIn: s.defaultBuyIn, expenseCents: s.expenseCents,
    isEnded: s.status.startsWith('Completed'), isDemo: false, players: s.players.map(p => ({ ...p })), paid: { ...(s.paid ?? {}) }
  };
  state.tab = 'table';
  commit();
}

export function deleteSaved(id: string) {
  state.saved = state.saved.filter(x => x.id !== id);
  state.storageOk = saveVault(state.saved) && state.storageOk;
  commit();
}
export function clearHistory() {
  state.saved = [];
  state.storageOk = saveVault(state.saved) && state.storageOk;
  commit();
}

export function sessionText(s: SavedSession | SessionData): string {
  return buildNotepad(s as SavedSession);
}

/** Returns a user-facing message, or null on invalid input. */
export function importBackup(text: string): string | null {
  const parsed = parseBackup(text);
  if (!parsed) return null;
  if (parsed.kind === 'vault') {
    const known = new Set(state.saved.map(s => s.id));
    const added = parsed.sessions.filter(s => !known.has(s.id));
    state.saved = [...added, ...state.saved];
    state.storageOk = saveVault(state.saved) && state.storageOk;
    commit();
    return added.length === 0 ? 'Those sessions are already in History' : `Imported ${added.length} session${added.length === 1 ? '' : 's'}`;
  }
  const s = parsed.session;
  state.session = {
    id: s.id, name: s.name, defaultBuyIn: s.defaultBuyIn, expenseCents: s.expenseCents,
    isEnded: false, isDemo: false, players: s.players, paid: {}
  };
  state.tab = 'table';
  commit();
  return `Restored “${s.name}”`;
}

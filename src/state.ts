import {
  buildNotepad, parseBackup, reconcile, sanitizeBuyIn, solve, toCents,
  type Player, type ReconcileMode, type SavedSession, type SessionData
} from './engine';
import { PRESETS, type Preset } from './presets';
import { loadLive, loadTheme, loadVault, saveLive, saveTheme, saveVault, type Theme } from './storage';

export type Tab = 'table' | 'settle' | 'history' | 'settings';

export interface State {
  tab: Tab;
  theme: Theme;
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
    players: p.players.map(x => ({ ...x, id: uid('p') })),
    paid: {}
  };
}

export const state: State = {
  tab: 'table',
  theme: loadTheme(),
  session: loadLive() ?? fromPreset(PRESETS[0]),
  saved: loadVault(),
  storageOk: true,
  lastSave: ''
};

type Listener = () => void;
const listeners: Listener[] = [];
export const subscribe = (fn: Listener) => listeners.push(fn);

const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export function commit() {
  state.storageOk = saveLive(state.session);
  state.lastSave = stamp().slice(11);
  listeners.forEach(fn => fn());
}

export const audit = () => solve(state.session.players, state.session.expenseCents, state.session.defaultBuyIn);
export const paidKey = (id: string, cents: number) => `${id}:${cents}`;

export function setTab(tab: Tab) { state.tab = tab; listeners.forEach(fn => fn()); }
export function setTheme(theme: Theme) { state.theme = theme; state.storageOk = saveTheme(theme) && state.storageOk; listeners.forEach(fn => fn()); }

export function setName(name: string) { state.session.name = name.trim().slice(0, 80) || 'Poker Session'; commit(); }
export function setUnit(v: string) { state.session.defaultBuyIn = sanitizeBuyIn(parseFloat(v)); commit(); }
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
  commit();
}

function snapshot(status: string): SavedSession {
  const s = state.session;
  return {
    id: s.id, name: s.name, timestamp: stamp(), status,
    defaultBuyIn: s.defaultBuyIn, expenseCents: s.expenseCents,
    players: s.players.map(p => ({ ...p }))
  };
}

export function saveToHistory(status = 'Saved Snapshot') {
  const snap = snapshot(status);
  const i = state.saved.findIndex(x => x.id === snap.id);
  if (i >= 0) state.saved[i] = snap; else state.saved.unshift(snap);
  state.storageOk = saveVault(state.saved) && state.storageOk;
  commit();
  return snap;
}

/** Locks the session; when chips don't match, balances them pro-rata first. */
export function endSession() {
  if (!audit().isBalanced) applyReconcile('proRataWinners');
  state.session.isEnded = true;
  saveToHistory('Completed & Settled');
}
export function reopenSession() { state.session.isEnded = false; commit(); }

export function newSession(p?: Preset) {
  state.session = p ? fromPreset(p) : {
    id: uid('sess'), name: 'New Poker Session', defaultBuyIn: 100, expenseCents: 0, isEnded: false, players: [], paid: {}
  };
  state.tab = 'table';
  commit();
}

export function loadSaved(id: string) {
  const s = state.saved.find(x => x.id === id);
  if (!s) return;
  state.session = {
    id: s.id, name: s.name, defaultBuyIn: s.defaultBuyIn, expenseCents: s.expenseCents,
    isEnded: s.status.startsWith('Completed'), players: s.players.map(p => ({ ...p })), paid: {}
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
    return `Imported ${added.length} session${added.length === 1 ? '' : 's'}`;
  }
  const s = parsed.session;
  state.session = {
    id: s.id, name: s.name, defaultBuyIn: s.defaultBuyIn, expenseCents: s.expenseCents,
    isEnded: false, players: s.players, paid: {}
  };
  state.tab = 'table';
  commit();
  return `Restored “${s.name}”`;
}

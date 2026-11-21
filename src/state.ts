import {
  MAX_BILLS, MAX_GUESTS, MAX_BILL_CENTS, MAX_LOG, formatCurrency, buildNotepad, parseBackup, parseBuyInUnit, reconcile, solve, toCents,
  type Bill, type Player, type ReconcileMode, type SavedSession, type SessionData
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
    paid: {},
    bills: []
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

let persistLocked = false;
/**
 * Another tab on this phone became the host of the table this tab was running. Both tabs share one saved copy, so
 * from now on this tab must not write it (that would erase the new host's key).
 */
export function lockPersistence() { persistLocked = true; }

export function commit() {
  if (!persistLocked) state.storageOk = saveLive(state.session);
  state.lastSave = stamp().slice(11);
  commitHooks.forEach(fn => fn());
  listeners.forEach(fn => fn());
}

export const audit = () => solve(state.session.players, state.session.expenseCents, state.session.defaultBuyIn, state.session.bills ?? []);
export { paidKey } from './engine';

type Share = NonNullable<SessionData['share']>;
const replacedHooks: ((old: Share) => void)[] = [];
/** Called when the open session is replaced while it was being shared, so its link can be stopped. */
export const onShareOrphaned = (fn: (old: Share) => void) => replacedHooks.push(fn);

/** Every path that swaps the open session goes through here, so a live link can never be orphaned. */
function replaceSession(next: SessionData) {
  const old = state.session.share;
  // taking over the SAME live table must not end its link
  if (old && old.code !== next.share?.code) replacedHooks.forEach(fn => fn(old));
  state.session = next;
}

/**
 * Becoming the host of a table someone else was running. The table that was open on this phone is kept in
 * History first, so nothing is lost.
 */
export function adoptSharedSession(s: { name: string; defaultBuyIn: number; expenseCents: number; isEnded: boolean; players: Player[]; paid: Record<string, boolean>; bills?: Bill[]; log?: { t: number; m: string }[] }, share: NonNullable<SessionData['share']>) {
  const cur = state.session;
  if (!cur.isDemo && cur.players.length > 0 && cur.share?.code !== share.code) saveToHistory('Saved before taking over a table');
  replaceSession({
    id: uid('sess'), name: s.name, defaultBuyIn: s.defaultBuyIn, expenseCents: s.expenseCents, isEnded: s.isEnded,
    isDemo: false, share, players: s.players.map(p => ({ ...p })), paid: { ...s.paid }, bills: (s.bills ?? []).map(b => ({ ...b })), log: (s.log ?? []).map(e => ({ ...e }))
  });
  state.tab = 'table';
  commit();
}

export function setShare(share: SessionData['share']) {
  state.session.share = share;
  commit();
}

/** What viewers are allowed to see: the table itself, never the host key. */
export function shareSnapshot() {
  const s = state.session;
  return {
    name: s.name, defaultBuyIn: s.defaultBuyIn, expenseCents: s.expenseCents,
    isEnded: s.isEnded, players: s.players, paid: s.paid, bills: s.bills ?? [], log: s.log ?? []
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

/** Remember something that happened, so viewers can see the game moving (last MAX_LOG entries). */
function note(m: string) {
  const s = state.session;
  s.log = [...(s.log ?? []), { t: Date.now(), m: m.slice(0, 80) }].slice(-MAX_LOG);
}

export function addPlayer(name: string, buyIns: number) {
  const unit = toCents(state.session.defaultBuyIn);
  state.session.players.push({
    id: uid('p'), name: name.trim().slice(0, 40) || `Player ${state.session.players.length + 1}`,
    buyInCents: Math.round(Math.max(0, buyIns) * unit), cashOutCents: 0
  });
  note(`${state.session.players[state.session.players.length - 1].name} joined`);
  commit();
}
export function removePlayer(id: string) {
  const gone = state.session.players.find(p => p.id === id);
  // an expense this player paid stays: it is now paid by someone who is not in the list
  if (gone) note(`${gone.name} left the table`);
  if (gone) for (const b of state.session.bills ?? []) if (b.payerId === id) { delete b.payerId; b.guest = gone.name; }
  for (const b of state.session.bills ?? []) if (b.sharedBy) { b.sharedBy = b.sharedBy.filter(x => x !== id); if (!b.sharedBy.length) delete b.sharedBy; }
  state.session.players = state.session.players.filter(p => p.id !== id);
  commit();
}

export type BillInput = { label: string; cents: number; payerId?: string; guest?: string; sharedBy?: string[] };
/** Returns an error message, or null when the expense was saved. */
export function checkBill(input: BillInput, ignoreId?: string): string | null {
  const s = state.session;
  if (!(input.cents > 0)) return 'Enter an amount greater than $0.';
  if (input.cents > MAX_BILL_CENTS) return 'That amount is too large.';
  if (!input.payerId && !input.guest?.trim()) return input.guest === undefined ? 'Pick who paid.' : 'Type the name of the person who paid.';
  const bills = (s.bills ?? []).filter(b => b.id !== ignoreId);
  if (bills.length >= MAX_BILLS) return `You can add up to ${MAX_BILLS} expenses.`;
  if (input.guest?.trim()) {
    const g = input.guest.trim().toLowerCase();
    const clash = s.players.find(p => p.name.trim().toLowerCase() === g);
    if (clash) return `${clash.name} is already a player — pick them above.`;
    const names = new Set(bills.filter(b => b.guest).map(b => b.guest!.trim().toLowerCase()));
    if (!names.has(g) && names.size >= MAX_GUESTS) return `You can add up to ${MAX_GUESTS} people who are not playing.`;
  }
  return null;
}
/** Adds or replaces an expense. Changing expenses changes who pays whom, so the "paid" ticks start over. */
export function saveBill(input: BillInput, id?: string): string | null {
  const err = checkBill(input, id);
  if (err) return err;
  const s = state.session;
  const bill: Bill = { id: id ?? uid('b'), label: input.label.trim().slice(0, 40) || 'Expense', cents: Math.round(input.cents) };
  if (input.payerId) bill.payerId = input.payerId; else bill.guest = input.guest!.trim().slice(0, 40);
  if (input.sharedBy?.length) bill.sharedBy = [...new Set(input.sharedBy)];
  const list = s.bills ?? [];
  s.bills = id && list.some(b => b.id === id) ? list.map(b => (b.id === id ? bill : b)) : [...list, bill];
  pruneShares();
  note(`${id ? 'Updated' : 'Added'} expense: ${bill.label} ${formatCurrency(bill.cents)}`);
  s.paid = {};
  commit();
  return null;
}
/** A guest id in someone's "shared by" list is only meaningful while that guest still paid for something. */
function pruneShares() {
  const s = state.session;
  const players = new Set(s.players.map(p => p.name.trim().toLowerCase()));
  const guests = new Set((s.bills ?? []).filter(b => !b.payerId && b.guest && !players.has(b.guest.trim().toLowerCase())).map(b => `guest:${b.guest!.trim().toLowerCase()}`));
  for (const b of s.bills ?? []) if (b.sharedBy) {
    b.sharedBy = b.sharedBy.filter(x => !x.startsWith('guest:') || guests.has(x));
    if (!b.sharedBy.length) delete b.sharedBy;
  }
}

export function removeBill(id: string) {
  const gone = (state.session.bills ?? []).find(b => b.id === id);
  if (gone) note(`Removed expense: ${gone.label}`);
  state.session.bills = (state.session.bills ?? []).filter(b => b.id !== id);
  pruneShares();
  state.session.paid = {};
  commit();
}
export function updatePlayer(id: string, patch: Partial<Player>) {
  const p = state.session.players.find(x => x.id === id);
  if (p && patch.cashOutCents !== undefined && patch.cashOutCents !== p.cashOutCents) note(`${p.name} chips ${formatCurrency(patch.cashOutCents)}`);
  if (p) Object.assign(p, patch);
  commit();
}
export function rebuy(id: string, delta: number) {
  const p = state.session.players.find(x => x.id === id);
  if (!p) return;
  const before = p.buyInCents;
  p.buyInCents = Math.max(0, p.buyInCents + delta * toCents(state.session.defaultBuyIn));
  if (p.buyInCents !== before) note(`${p.name} ${delta > 0 ? 'bought in' : 'took back'} ${formatCurrency(Math.abs(p.buyInCents - before))}`);
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
    paid: { ...s.paid },
    bills: (s.bills ?? []).map(b => ({ ...b }))
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
  note('Game settled');
  if (state.session.isDemo) commit(); else saveToHistory('Completed & Settled');
  return true;
}
export function reopenSession() { state.session.isEnded = false; note('Game reopened'); commit(); }

export function newSession(p?: Preset) {
  replaceSession(p ? fromPreset(p) : {
    id: uid('sess'), name: 'New Poker Session', defaultBuyIn: 100, expenseCents: 0, isEnded: false, isDemo: false, players: [], paid: {}, bills: []
  });
  state.tab = 'table';
  commit();
}

export function loadSaved(id: string) {
  const s = state.saved.find(x => x.id === id);
  if (!s) return;
  replaceSession({
    id: s.id, name: s.name, defaultBuyIn: s.defaultBuyIn, expenseCents: s.expenseCents,
    isEnded: s.status.startsWith('Completed'), isDemo: false, players: s.players.map(p => ({ ...p })), paid: { ...(s.paid ?? {}) }, bills: (s.bills ?? []).map(b => ({ ...b }))
  });
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
  replaceSession({
    id: s.id, name: s.name, defaultBuyIn: s.defaultBuyIn, expenseCents: s.expenseCents,
    isEnded: false, isDemo: false, players: s.players, paid: {}, bills: s.bills ?? []
  });
  state.tab = 'table';
  commit();
  return `Restored “${s.name}”`;
}

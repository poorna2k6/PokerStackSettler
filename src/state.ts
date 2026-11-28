import {
  MAX_BILLS, MAX_GUESTS, MAX_BILL_CENTS, MAX_LOG, MAX_CHIPS_PER_BUYIN, chipRateCents, chipSummary, reconcileChips, safeChipCount, formatCurrency, buildNotepad, parseBackup, parseBuyInUnit, reconcile, solve, toCents,
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
  /** another tab on this phone changed the saved game: this tab stops saving so it cannot overwrite it */
  staleTab: boolean;
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
  staleTab: false,
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

// Two tabs share one saved game. When another tab saves it, this tab must not write over it: it locks and asks to reload.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key !== 'stacksettle_live_autosave_v1' || persistLocked) return;
    persistLocked = true;
    state.staleTab = true;
    listeners.forEach(fn => fn());
  });
}

let vaultFailed = false;
/** Writes History. A failed write keeps the warning banner up until a later write works (a save to the live copy must not hide it). */
function writeVault(): boolean {
  const ok = saveVault(state.saved);
  vaultFailed = !ok;
  if (!ok) state.storageOk = false;
  return ok;
}

export function commit() {
  if (!persistLocked) state.storageOk = saveLive(state.session) && !vaultFailed;
  state.lastSave = stamp().slice(11);
  commitHooks.forEach(fn => fn());
  listeners.forEach(fn => fn());
}

/** The settlement as it will be after "Balance & settle": so the preview matches the result to the cent. */
export function previewAudit() {
  const s = state.session;
  let players = s.players;
  if (!audit().isBalanced && !(audit().totalBuyInCents > 0 && audit().totalPlayerCashOutCents === 0)) {
    const fixed = s.chipsPerBuyIn
      ? reconcileChips(players, s.expenseCents, 'proRataWinners', s.defaultBuyIn, s.chipsPerBuyIn)
      : reconcile(players, s.expenseCents, 'proRataWinners', s.defaultBuyIn);
    if (solve(fixed, s.expenseCents, s.defaultBuyIn).isBalanced) players = fixed;
  }
  return solve(players, s.expenseCents, s.defaultBuyIn, s.bills ?? [], s.round === true);
}

export const audit = () => solve(state.session.players, state.session.expenseCents, state.session.defaultBuyIn, state.session.bills ?? [], state.session.round === true);
export { paidKey } from './engine';

type Share = NonNullable<SessionData['share']>;
const replacedHooks: ((old: Share) => void)[] = [];
/** Called when the open session is replaced while it was being shared, so its link can be stopped. */
export const onShareOrphaned = (fn: (old: Share) => void) => replacedHooks.push(fn);

/** Every path that swaps the open session goes through here, so a live link can never be orphaned. */
function replaceSession(next: SessionData) {
  // Never throw a game away: a real table with players is put in History first (unless it is already there).
  const cur = state.session;
  if (!cur.isDemo && cur.players.length > 0 && next.id !== cur.id) {
    const known = state.saved.find(x => x.id === cur.id);
    saveToHistory(known ? known.status : 'Saved before replacing');
  }
  const old = state.session.share;
  // taking over the SAME live table must not end its link
  if (old && old.code !== next.share?.code) replacedHooks.forEach(fn => fn(old));
  state.session = next;
}

/**
 * Becoming the host of a table someone else was running. The table that was open on this phone is kept in
 * History first, so nothing is lost.
 */
export function adoptSharedSession(s: { name: string; defaultBuyIn: number; expenseCents: number; isEnded: boolean; players: Player[]; paid: Record<string, boolean>; bills?: Bill[]; log?: { t: number; m: string }[]; note?: string; round?: boolean; chipsPerBuyIn?: number }, share: NonNullable<SessionData['share']>) {
  const cur = state.session;
  if (!cur.isDemo && cur.players.length > 0 && cur.share?.code !== share.code) saveToHistory('Saved before taking over a table');
  replaceSession({
    id: uid('sess'), name: s.name, defaultBuyIn: s.defaultBuyIn, chipsPerBuyIn: s.chipsPerBuyIn, expenseCents: s.expenseCents, isEnded: s.isEnded,
    isDemo: false, share, players: s.players.map(p => ({ ...p })), paid: { ...s.paid }, bills: (s.bills ?? []).map(b => ({ ...b })), log: (s.log ?? []).map(e => ({ ...e })), note: s.note ?? '', round: s.round === true
  });
  state.tab = 'table';
  commit();
}

export function setRound(on: boolean) { state.session.round = on; state.session.paid = {}; commit(); }
export function setNote(v: string) { state.session.note = v.slice(0, 240); commit(); }
export function setFinalTtl(sec: number) { state.session.finalTtl = sec; commit(); }

export function setShare(share: SessionData['share']) {
  state.session.share = share;
  commit();
}

/** What viewers are allowed to see: the table itself, never the host key. */
export function shareSnapshot() {
  const s = state.session;
  return {
    name: s.name, defaultBuyIn: s.defaultBuyIn, chipsPerBuyIn: s.chipsPerBuyIn, expenseCents: s.expenseCents,
    isEnded: s.isEnded, players: s.players, paid: s.paid, bills: s.bills ?? [], log: s.log ?? [], note: s.note ?? '', round: s.round === true
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
  if (state.session.chipsPerBuyIn) return true; // in a chip-count game the buy-in value is set with the chips
  if (n !== null) state.session.defaultBuyIn = n;
  commit();
  return n !== null;
}
export function setExpense(v: string) {
  let cents = Math.max(0, toCents(v));
  const rate = chipRate();
  if (rate) cents = Math.round(cents / rate) * rate; // the rake is chips the house keeps: a whole number of chips
  state.session.expenseCents = cents;
  commit();
}

/** What one chip is worth in cents in this game, or null when the game is not a chip-count game. */
export function chipRate(): number | null {
  const s = state.session;
  return s.chipsPerBuyIn ? chipRateCents(s.defaultBuyIn, s.chipsPerBuyIn) : null;
}
/** Chip counts for the open game (null when it is a plain dollar game). */
export const chipInfo = () => {
  const s = state.session;
  return s.chipsPerBuyIn ? chipSummary(s.players, s.defaultBuyIn, s.chipsPerBuyIn, s.expenseCents) : null;
};

/**
 * Sets up a chip-count game: how many chips each buy-in gives and what the buy-in is worth in real money.
 * Returns an error message, or null when saved. Only possible before anyone has bought in.
 */
export function setupChips(chipsPerBuyIn: number, unitDollars: number): string | null {
  const s = state.session;
  const unit = parseBuyInUnit(unitDollars);
  if (unit === null) return 'Enter what one buy-in is worth in real money, for example 10.';
  if (!Number.isInteger(chipsPerBuyIn) || chipsPerBuyIn < 1) return 'Enter how many chips one buy-in gives, for example 40.';
  if (chipsPerBuyIn > MAX_CHIPS_PER_BUYIN) return `Use at most ${MAX_CHIPS_PER_BUYIN.toLocaleString()} chips per buy-in.`;
  if (chipRateCents(unit, chipsPerBuyIn) === null) {
    const cents = toCents(unit);
    const near = [...Array(chipsPerBuyIn + 40).keys()].map(i => i + 1).filter(n => cents % n === 0).sort((a, b) => Math.abs(a - chipsPerBuyIn) - Math.abs(b - chipsPerBuyIn)).slice(0, 3).sort((a, b) => a - b);
    return `${formatCurrency(cents)} can’t be split into exactly ${chipsPerBuyIn} chips (a chip must be worth a whole number of cents). Try ${near.join(', ')} chips instead.`;
  }
  if (s.players.some(p => p.buyInCents > 0)) return 'Chips can only be changed before anyone has bought in.';
  s.defaultBuyIn = unit;
  s.chipsPerBuyIn = chipsPerBuyIn;
  s.players.forEach(p => { p.cashOutChips = 0; p.cashOutCents = 0; });
  s.expenseCents = 0;
  commit();
  return null;
}

/** Remember something that happened, so viewers can see the game moving (last MAX_LOG entries). */
function note(m: string) {
  const s = state.session;
  s.log = [...(s.log ?? []), { t: Date.now(), m: m.slice(0, 80) }].slice(-MAX_LOG);
}

/** A name must be typed, and must not already belong to another player (two Anns make "Ann pays Ann"). */
export function checkPlayerName(name: string, ignoreId?: string): string | null {
  const n = name.trim();
  if (!n) return 'Type a name.';
  const clash = state.session.players.find(p => p.id !== ignoreId && p.name.trim().toLowerCase() === n.toLowerCase());
  return clash ? `There is already a player called ${clash.name}. Add a last name or initial.` : null;
}

/** Returns an error message, or null when the player was added. */
export function addPlayer(name: string, buyIns: number): string | null {
  const s = state.session;
  const nameErr = checkPlayerName(name);
  if (nameErr) return nameErr;
  if (!Number.isFinite(buyIns) || buyIns <= 0) return 'Buy-ins must be more than 0 (for example 1 or 2).';
  if (buyIns > 1000) return 'That is too many buy-ins.';
  const unit = toCents(s.defaultBuyIn);
  let buyInCents = Math.round(buyIns * unit);
  const rate = chipRate();
  if (rate && s.chipsPerBuyIn) {
    // a chip game only hands out whole chips
    const chips = buyIns * s.chipsPerBuyIn;
    if (Math.abs(chips - Math.round(chips)) > 1e-9) return `${buyIns} buy-ins isn’t a whole number of chips (one buy-in is ${s.chipsPerBuyIn} chips). Use a count that gives whole chips.`;
    buyInCents = Math.round(chips) * rate;
  }
  s.players.push({ id: uid('p'), name: name.trim().slice(0, 40), buyInCents, cashOutCents: 0, ...(rate ? { cashOutChips: 0 } : {}) });
  note(`${s.players[s.players.length - 1].name} joined`);
  commit();
  return null;
}
export function removePlayer(id: string) {
  const gone = state.session.players.find(p => p.id === id);
  // an expense this player paid stays: it is now paid by someone who is not in the list
  if (gone) note(`${gone.name} left the table`);
  if (gone) for (const b of state.session.bills ?? []) if (b.payerId === id) { delete b.payerId; b.guest = gone.name; }
  dropEmptied(state.session.bills ?? [], b => { b.sharedBy = b.sharedBy!.filter(x => x !== id); });
  state.session.players = state.session.players.filter(p => p.id !== id);
  state.session.paid = {}; // who pays whom changes when someone leaves
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
  dropEmptied(s.bills ?? [], b => { b.sharedBy = b.sharedBy!.filter(x => !x.startsWith('guest:') || guests.has(x) || players.has(x.slice('guest:'.length))); });
}

/**
 * Runs `prune` on every bill that has a chosen list of sharers. A bill whose last sharer is gone has nobody left to
 * split it, so it is removed (and logged) instead of silently turning into "shared by everyone".
 */
function dropEmptied(bills: Bill[], prune: (b: Bill) => void) {
  const keep: Bill[] = [];
  for (const b of bills) {
    if (!b.sharedBy) { keep.push(b); continue; }
    prune(b);
    if (b.sharedBy.length) keep.push(b);
    else note(`Removed expense “${b.label}”: nobody left to share it`);
  }
  state.session.bills = keep;
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
  const rate = chipRate();
  if (p && rate && patch.cashOutChips !== undefined) {
    // chip-count game: the chips are what is typed, the money is always chips x chip value
    const chips = safeChipCount(patch.cashOutChips);
    if (chips !== (p.cashOutChips ?? 0)) note(`${p.name} returned ${chips} chips`);
    p.cashOutChips = chips;
    p.cashOutCents = chips * rate;
    delete p.typedChips; // a fresh count replaces any earlier adjustment
    commit();
    return;
  }
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
  const s = state.session;
  s.players = s.chipsPerBuyIn
    ? reconcileChips(s.players, s.expenseCents, mode, s.defaultBuyIn, s.chipsPerBuyIn)
    : reconcile(s.players, s.expenseCents, mode, s.defaultBuyIn);
  commit();
}

export function togglePaid(key: string) {
  if (state.session.paid[key]) delete state.session.paid[key]; else state.session.paid[key] = true;
  // keep the History copy of this session in step, so reopening it later shows the same paid marks
  const saved = state.saved.find(x => x.id === state.session.id);
  if (saved && !state.session.isDemo) {
    saved.paid = { ...state.session.paid };
    writeVault();
  }
  commit();
}

function snapshot(status: string): SavedSession {
  const s = state.session;
  return {
    id: s.id, name: s.name, timestamp: stamp(), status,
    defaultBuyIn: s.defaultBuyIn, chipsPerBuyIn: s.chipsPerBuyIn, expenseCents: s.expenseCents,
    players: s.players.map(p => ({ ...p })),
    paid: { ...s.paid },
    bills: (s.bills ?? []).map(b => ({ ...b })),
    round: s.round === true
  };
}

/** Demo sessions are never written to History. Returns null in that case. */
export function saveToHistory(status = 'Saved Snapshot'): SavedSession | null {
  if (state.session.isDemo) return null;
  const snap = snapshot(status);
  const i = state.saved.findIndex(x => x.id === snap.id);
  if (i >= 0) state.saved[i] = snap; else state.saved.unshift(snap);
  const ok = writeVault();
  commit();
  return ok ? snap : null; // null: nothing was stored (blocked or full)
}

/**
 * Locks the session; when chips don't match, balances them pro-rata first.
 * Returns false (and leaves the session open) if the table cannot be balanced,
 * e.g. the expense pot is larger than everything that was bought in.
 */
export function endSession(): boolean {
  // nobody has handed anything back: settling now would invent winners and losers
  const a0 = audit();
  if (a0.totalBuyInCents > 0 && a0.totalPlayerCashOutCents === 0) return false;
  if (!audit().isBalanced) {
    const s = state.session;
    const fixed = s.chipsPerBuyIn
      ? reconcileChips(s.players, s.expenseCents, 'proRataWinners', s.defaultBuyIn, s.chipsPerBuyIn)
      : reconcile(s.players, s.expenseCents, 'proRataWinners', s.defaultBuyIn);
    // Only keep the adjustment if it actually balances; a refusal must not alter what the user typed.
    if (!solve(fixed, s.expenseCents, s.defaultBuyIn).isBalanced) return false;
    const changed = fixed.filter((p, i) => p.cashOutCents !== s.players[i].cashOutCents).length;
    s.players = fixed;
    note(`Balanced the table: adjusted ${changed} player${changed === 1 ? '' : 's'}`);
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
    id: s.id, name: s.name, defaultBuyIn: s.defaultBuyIn, chipsPerBuyIn: s.chipsPerBuyIn, expenseCents: s.expenseCents,
    isEnded: s.status.startsWith('Completed'), isDemo: false, players: s.players.map(p => ({ ...p })), paid: { ...(s.paid ?? {}) }, bills: (s.bills ?? []).map(b => ({ ...b })), round: s.round === true
  });
  state.tab = 'table';
  commit();
}

export function deleteSaved(id: string) {
  state.saved = state.saved.filter(x => x.id !== id);
  writeVault();
  commit();
}
export function clearHistory() {
  state.saved = [];
  writeVault();
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
    writeVault();
    commit();
    return added.length === 0 ? 'Those sessions are already in History' : `Imported ${added.length} session${added.length === 1 ? '' : 's'}`;
  }
  const s = parsed.session;
  replaceSession({
    id: s.id, name: s.name, defaultBuyIn: s.defaultBuyIn, chipsPerBuyIn: s.chipsPerBuyIn, expenseCents: s.expenseCents,
    isEnded: false, isDemo: false, players: s.players, paid: {}, bills: s.bills ?? [], round: s.round === true
  });
  state.tab = 'table';
  commit();
  return `Restored “${s.name}”`;
}

// Pure settlement logic. No DOM, no storage — everything here is unit tested.

export interface Player {
  id: string;
  name: string;
  buyInCents: number;
  cashOutCents: number;
}

export interface Transfer {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  amountCents: number;
  isHouse: boolean;
}

export interface AuditPlayer extends Player {
  buyInCount: number;
  netCents: number;
}

export interface Audit {
  players: AuditPlayer[];
  totalBuyInCents: number;
  totalBuyInCount: number;
  totalPlayerCashOutCents: number;
  expenseCents: number;
  totalAccountedCents: number;
  discrepancyCents: number;
  isBalanced: boolean;
  transfers: Transfer[];
}

export type ReconcileMode = 'proRataWinners' | 'equalSplit' | 'topWinner';

export const HOUSE_ID = '__house_expense__';
export const MAX_NAME = 40;
/** Largest participant count for which the provably minimal transfer search runs. */
const EXACT_LIMIT = 16;

export function toCents(val: unknown): number {
  const num = typeof val === 'number' ? val : parseFloat(String(val ?? ''));
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
}

export function formatCurrency(cents: number, showSign = false): string {
  const sign = cents < 0 ? '-' : showSign && cents > 0 ? '+' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function unitCentsFor(stdBuyInDollars: number): number {
  return Math.max(100, toCents(stdBuyInDollars || 100));
}

export function buyInCount(buyInCents: number, stdBuyInDollars: number): number {
  return Math.round((buyInCents / unitCentsFor(stdBuyInDollars)) * 10) / 10;
}

export function formatBuyInCount(count: number): string {
  return Number.isInteger(count) ? `${count}x` : `${count.toFixed(1)}x`;
}

function cleanName(name: unknown): string {
  const s = String(name ?? '').trim().slice(0, MAX_NAME);
  return s || 'Player';
}

interface Node {
  id: string;
  name: string;
  /** positive = is owed, negative = owes */
  net: number;
  isHouse: boolean;
}

function makeTransfer(from: Node, to: Node, amountCents: number): Transfer {
  return {
    id: `${from.id}->${to.id}`,
    fromId: from.id,
    fromName: from.name,
    toId: to.id,
    toName: to.name,
    amountCents,
    isHouse: to.isHouse
  };
}

/** Largest-debtor-to-largest-creditor settlement of a set of nodes. */
function greedySettle(nodes: Node[]): Transfer[] {
  const debtors = nodes.filter(n => n.net < 0).map(n => ({ n, left: -n.net }));
  const creditors = nodes.filter(n => n.net > 0).map(n => ({ n, left: n.net }));
  const order = (a: { n: Node; left: number }, b: { n: Node; left: number }) =>
    b.left - a.left || a.n.name.localeCompare(b.n.name) || a.n.id.localeCompare(b.n.id);
  debtors.sort(order);
  creditors.sort(order);

  const out: Transfer[] = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amt = Math.min(debtors[d].left, creditors[c].left);
    if (amt > 0) out.push(makeTransfer(debtors[d].n, creditors[c].n, amt));
    debtors[d].left -= amt;
    creditors[c].left -= amt;
    if (debtors[d].left === 0) d++;
    if (creditors[c].left === 0) c++;
  }
  return out;
}

/**
 * Settlement with the fewest payments. Transfers needed = people − independent
 * zero-sum groups, so we find the maximum number of disjoint zero-sum subsets
 * (bitmask DP, exact up to EXACT_LIMIT people) and settle each group greedily.
 * Above the limit it falls back to plain greedy.
 */
export function settleNodes(nodes: Node[]): Transfer[] {
  const active = nodes.filter(n => n.net !== 0);
  const n = active.length;
  if (n === 0) return [];
  if (n > EXACT_LIMIT) return greedySettle(active);

  const size = 1 << n;
  const sum = new Int32Array(size);
  for (let m = 1; m < size; m++) {
    const low = m & -m;
    sum[m] = sum[m ^ low] + active[31 - Math.clz32(low)].net;
  }
  const best = new Int16Array(size);
  const prev = new Int8Array(size).fill(-1);
  for (let m = 1; m < size; m++) {
    let bestVal = -1;
    let bestBit = -1;
    for (let i = 0; i < n; i++) {
      if (!(m & (1 << i))) continue;
      const v = best[m ^ (1 << i)];
      if (v > bestVal) {
        bestVal = v;
        bestBit = i;
      }
    }
    best[m] = bestVal + (sum[m] === 0 ? 1 : 0);
    prev[m] = bestBit;
  }

  // Walk back to recover an ordering, then cut it wherever the running sum is zero.
  const order: number[] = [];
  for (let m = size - 1; m > 0; m ^= 1 << prev[m]) order.push(prev[m]);
  order.reverse();

  const groups: Node[][] = [];
  let current: Node[] = [];
  let running = 0;
  for (const idx of order) {
    current.push(active[idx]);
    running += active[idx].net;
    if (running === 0) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups.flatMap(greedySettle);
}

export function solve(
  players: Player[],
  expenseCents = 0,
  stdBuyInDollars = 100
): Audit {
  const unit = unitCentsFor(stdBuyInDollars);
  const clean: AuditPlayer[] = players.map(p => {
    const bi = Math.max(0, Math.round(p.buyInCents || 0));
    const co = Math.max(0, Math.round(p.cashOutCents || 0));
    return {
      id: p.id,
      name: cleanName(p.name),
      buyInCents: bi,
      cashOutCents: co,
      buyInCount: Math.round((bi / unit) * 10) / 10,
      netCents: co - bi
    };
  });

  const totalBuyInCents = clean.reduce((a, p) => a + p.buyInCents, 0);
  const totalPlayerCashOutCents = clean.reduce((a, p) => a + p.cashOutCents, 0);
  const validExpense = Math.max(0, Math.round(expenseCents || 0));
  const totalAccountedCents = totalPlayerCashOutCents + validExpense;
  const discrepancyCents = totalAccountedCents - totalBuyInCents;

  const nodes: Node[] = clean.map(p => ({ id: p.id, name: p.name, net: p.netCents, isHouse: false }));
  if (validExpense > 0) {
    nodes.push({ id: HOUSE_ID, name: 'House / Expense Pot', net: validExpense, isHouse: true });
  }

  return {
    players: clean,
    totalBuyInCents,
    totalBuyInCount: Math.round((totalBuyInCents / unit) * 10) / 10,
    totalPlayerCashOutCents,
    expenseCents: validExpense,
    totalAccountedCents,
    discrepancyCents,
    isBalanced: discrepancyCents === 0,
    transfers: settleNodes(nodes)
  };
}

/** Returns new players whose cash-outs add up to buy-ins minus the expense pot. */
export function reconcile(
  players: Player[],
  expenseCents: number,
  mode: ReconcileMode,
  stdBuyInDollars = 100
): Player[] {
  const audit = solve(players, expenseCents, stdBuyInDollars);
  if (audit.isBalanced || players.length === 0) return players;

  const cloned = players.map(p => ({ ...p }));
  let need = -audit.discrepancyCents; // negative = remove chips
  const floor = -cloned.reduce((a, p) => a + p.cashOutCents, 0);
  if (need < floor) need = floor;

  const apply = (p: Player, delta: number): number => {
    const applied = Math.max(-p.cashOutCents, delta);
    p.cashOutCents += applied;
    return applied;
  };

  if (mode === 'topWinner') {
    let best = 0;
    for (let i = 1; i < cloned.length; i++) {
      const a = cloned[i].cashOutCents - cloned[i].buyInCents;
      const b = cloned[best].cashOutCents - cloned[best].buyInCents;
      if (a > b) best = i;
    }
    need -= apply(cloned[best], need);
  } else if (mode === 'proRataWinners') {
    const winners = cloned.filter(p => p.cashOutCents - p.buyInCents > 0);
    const totalWin = winners.reduce((a, w) => a + (w.cashOutCents - w.buyInCents), 0);
    if (winners.length > 0) {
      let distributed = 0;
      winners.forEach((w, i) => {
        const win = w.cashOutCents - w.buyInCents;
        const desired =
          i === winners.length - 1 ? need - distributed : Math.round((need * win) / totalWin);
        distributed += apply(w, desired);
      });
      need -= distributed;
    }
  }

  // Equal split, and mop-up for whatever the other modes could not place.
  let guard = 0;
  while (need !== 0 && guard++ < 50) {
    const eligible = need > 0 ? cloned : cloned.filter(p => p.cashOutCents > 0);
    if (eligible.length === 0) break;
    const base = Math.trunc(need / eligible.length) || (need > 0 ? 1 : -1);
    let used = 0;
    eligible.forEach((p, i) => {
      const rem = need - used;
      if (rem === 0) return;
      const share = i === eligible.length - 1 ? rem : base;
      used += apply(p, Math.abs(share) > Math.abs(rem) ? rem : share);
    });
    need -= used;
  }
  return cloned;
}

// ---------------------------------------------------------------------------
// Validation of anything that comes from storage or an imported file
// ---------------------------------------------------------------------------

const MAX_CENTS = 1_000_000_00; // $1,000,000 per player — rejects absurd/hostile values

function safeCents(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_CENTS, Math.max(0, Math.round(n)));
}

export function sanitizePlayers(raw: unknown): Player[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Player[] = [];
  raw.slice(0, 60).forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const o = r as Record<string, unknown>;
    let id = typeof o.id === 'string' && o.id ? o.id.slice(0, 64) : `p_${i}`;
    while (seen.has(id)) id += '_';
    seen.add(id);
    out.push({
      id,
      name: cleanName(o.name),
      buyInCents: safeCents(o.buyInCents),
      cashOutCents: safeCents(o.cashOutCents)
    });
  });
  return out;
}

export interface SessionData {
  id: string;
  name: string;
  defaultBuyIn: number;
  expenseCents: number;
  isEnded: boolean;
  /** true while showing built-in demo data; demo sessions are never saved to History */
  isDemo?: boolean;
  players: Player[];
  paid: Record<string, boolean>;
}

export interface SavedSession {
  id: string;
  name: string;
  timestamp: string;
  status: string;
  defaultBuyIn: number;
  expenseCents: number;
  players: Player[];
}

export function sanitizeBuyIn(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 100000 ? n : 100;
}

export function sanitizeSaved(raw: unknown): SavedSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const players = sanitizePlayers(o.players);
  if (players.length === 0) return null;
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 64) : `restored_${Date.now()}`,
    name: String(o.name ?? 'Restored Session').slice(0, 80),
    timestamp: String(o.timestamp ?? '').slice(0, 32),
    status: String(o.status ?? 'Saved Snapshot').slice(0, 40),
    defaultBuyIn: sanitizeBuyIn(o.defaultBuyIn),
    expenseCents: safeCents(o.expenseCents),
    players
  };
}

export type ParsedBackup =
  | { kind: 'vault'; sessions: SavedSession[] }
  | { kind: 'session'; session: SavedSession };

const MARKER = 'STACKSETTLE_BACKUP_JSON:';

/** Accepts a .txt notepad backup, a vault JSON array, or a single-session JSON. */
export function parseBackup(text: string): ParsedBackup | null {
  const line = text.split(/\r?\n/).find(l => l.startsWith(MARKER));
  let data: unknown;
  try {
    data = JSON.parse(line ? line.slice(MARKER.length) : text);
  } catch {
    return null;
  }
  if (Array.isArray(data)) {
    const sessions = data.map(sanitizeSaved).filter((s): s is SavedSession => s !== null);
    return sessions.length ? { kind: 'vault', sessions } : null;
  }
  const session = sanitizeSaved(data);
  return session ? { kind: 'session', session } : null;
}

export function buildNotepad(s: SavedSession | (SessionData & { timestamp?: string; status?: string })): string {
  const expense = 'expenseCents' in s ? s.expenseCents : 0;
  const audit = solve(s.players, expense, s.defaultBuyIn);
  const stamp =
    ('timestamp' in s && s.timestamp) || new Date().toISOString().slice(0, 16).replace('T', ' ');
  const status = ('status' in s && s.status) || 'Live Auto-Saved';
  const bar = '='.repeat(64);
  const dash = '-'.repeat(64);

  const lines = [
    bar,
    'STACKSETTLE PRO — BUY-IN & SETTLEMENT LOG',
    bar,
    `Session Name   : ${s.name || 'Poker Cash Game'}`,
    `Saved Timestamp: ${stamp}`,
    `Session Status : ${status}`,
    `1 Buy-In Unit  : $${s.defaultBuyIn}`,
    `Total Table Pot: ${formatCurrency(audit.totalBuyInCents)} (${formatBuyInCount(audit.totalBuyInCount)} across ${audit.players.length} players)`,
    `Table Balance  : ${audit.isBalanced ? 'BALANCED' : 'DISCREPANCY ' + formatCurrency(audit.discrepancyCents, true)}`,
    dash,
    '1. PLAYER LEDGER',
    dash,
    '#   Player               Buy-Ins   Buy-In ($)   End Chips ($)   Net'
  ];
  audit.players.forEach((p, i) => {
    lines.push(
      [
        String(i + 1).padEnd(3),
        p.name.slice(0, 19).padEnd(20),
        formatBuyInCount(p.buyInCount).padEnd(9),
        formatCurrency(p.buyInCents).padEnd(12),
        formatCurrency(p.cashOutCents).padEnd(15),
        formatCurrency(p.netCents, true)
      ].join(' ')
    );
  });
  lines.push(dash, `2. WHO PAYS WHOM (${audit.transfers.length} transfers)`, dash);
  if (audit.transfers.length === 0) lines.push('* No payments needed.');
  audit.transfers.forEach((t, i) =>
    lines.push(`${i + 1}. ${t.fromName} ---> ${t.toName}: ${formatCurrency(t.amountCents)}`)
  );
  const payload = JSON.stringify({
    id: s.id,
    name: s.name,
    defaultBuyIn: s.defaultBuyIn,
    expenseCents: expense,
    players: s.players
  });
  lines.push(bar, 'MACHINE RESTORE PAYLOAD (keep this line to restore into the app):', MARKER + payload, bar);
  return lines.join('\n');
}

export function buildReceipt(
  name: string,
  audit: Audit,
  paid: Record<string, boolean>
): string {
  const lines = [`♠️ ${name} — Final Settlement`, ''];
  if (audit.transfers.length === 0) lines.push('No payments needed.');
  audit.transfers.forEach(t =>
    lines.push(`${paid[t.id] ? '✅' : '⬜'} ${t.fromName} ➡️ ${t.toName}: ${formatCurrency(t.amountCents)}`)
  );
  lines.push('', 'Results:');
  [...audit.players]
    .sort((a, b) => b.netCents - a.netCents)
    .forEach(p =>
      lines.push(`• ${p.name} [${formatBuyInCount(p.buyInCount)}]: ${formatCurrency(p.netCents, true)}`)
    );
  return lines.join('\n');
}

export interface LeaderRow {
  name: string;
  sessions: number;
  netCents: number;
  buyInCents: number;
}

export function leaderboard(sessions: SavedSession[]): LeaderRow[] {
  const map = new Map<string, LeaderRow>();
  for (const s of sessions) {
    for (const p of s.players) {
      const key = p.name.trim().toLowerCase();
      const row = map.get(key) ?? { name: p.name, sessions: 0, netCents: 0, buyInCents: 0 };
      row.sessions += 1;
      row.netCents += p.cashOutCents - p.buyInCents;
      row.buyInCents += p.buyInCents;
      map.set(key, row);
    }
  }
  return [...map.values()].sort((a, b) => b.netCents - a.netCents);
}

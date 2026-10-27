import { describe, expect, it } from 'vitest';
import {
  buildNotepad, buildReceipt, buyInCount, paidKey, uniqueSessionIds, formatUnit, leaderboard, parseBuyInUnit, sanitizeBuyIn, parseBackup, reconcile, sanitizePlayers, settleNodes, solve,
  formatCurrency, toCents, type Player
} from './engine';

const P = (id: string, bi: number, co: number): Player => ({ id, name: id, buyInCents: bi, cashOutCents: co });

// Deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomGame(r: () => number, n: number): Player[] {
  const players = Array.from({ length: n }, (_, i) => P(`p${i}`, (1 + Math.floor(r() * 4)) * 10000, 0));
  let pot = players.reduce((a, p) => a + p.buyInCents, 0);
  for (let i = 0; i < n - 1; i++) {
    const take = Math.floor(r() * pot * (r() < 0.3 ? 0 : 0.6));
    players[i].cashOutCents = take;
    pot -= take;
  }
  players[n - 1].cashOutCents = pot;
  return players;
}

/** Applying every transfer must leave every balance at zero. */
function netAfter(players: Player[], audit: ReturnType<typeof solve>, expense: number) {
  const bal = new Map(players.map(p => [p.id, p.cashOutCents - p.buyInCents]));
  if (expense) bal.set('__house_expense__', expense);
  for (const t of audit.transfers) {
    bal.set(t.fromId, bal.get(t.fromId)! + t.amountCents);
    bal.set(t.toId, bal.get(t.toId)! - t.amountCents);
  }
  return [...bal.values()];
}

describe('toCents', () => {
  it('parses and rounds safely', () => {
    expect(toCents('12.345')).toBe(1235);
    expect(toCents('abc')).toBe(0);
    expect(toCents(Infinity)).toBe(0);
    expect(toCents(0)).toBe(0);
    expect(toCents(undefined)).toBe(0);
  });

  it('rounds half-up on the decimal string, not on binary floats', () => {
    expect(toCents('1.005')).toBe(101);
    expect(toCents('0.285')).toBe(29);
    expect(toCents(1.005)).toBe(101);
    expect(toCents('61.75')).toBe(6175);
    expect(toCents('0.1') + toCents('0.2')).toBe(30);
  });

  it('tolerates $ , and spaces; rejects junk', () => {
    expect(toCents('$1,000.50')).toBe(100050);
    expect(toCents(' $20 ')).toBe(2000);
    expect(toCents('.5')).toBe(50);
    expect(toCents('5.')).toBe(500);
    expect(toCents('-5')).toBe(-500);
    expect(toCents('1e3')).toBe(0);
    expect(toCents('1.2.3')).toBe(0);
    expect(toCents('')).toBe(0);
    expect(toCents('.')).toBe(0);
    expect(toCents('9'.repeat(40))).toBe(0);
  });
});

describe('buy-in unit', () => {
  it('accepts $0.01 to $100,000 and rounds to cents', () => {
    expect(parseBuyInUnit('0.5')).toBe(0.5);
    expect(parseBuyInUnit('25.555')).toBe(25.56);
    expect(parseBuyInUnit('100000')).toBe(100000);
    expect(parseBuyInUnit('0')).toBeNull();
    expect(parseBuyInUnit('abc')).toBeNull();
    expect(parseBuyInUnit('100001')).toBeNull();
    expect(sanitizeBuyIn('nope')).toBe(100);
  });

  it('counts buy-ins correctly for sub-dollar units', () => {
    expect(buyInCount(250, 0.5)).toBe(5);
  });

  it('formats units', () => {
    expect(formatUnit(100)).toBe('$100');
    expect(formatUnit(1.5)).toBe('$1.50');
    expect(formatUnit(0.25)).toBe('$0.25');
    expect(formatUnit(1000)).toBe('$1,000');
    expect(formatUnit(1500.5)).toBe('$1,500.50');
    expect(buildNotepad({ id: 'x', name: 'n', defaultBuyIn: 1500.5, expenseCents: 0, isEnded: false, paid: {}, players: [P('a', 1, 1)] })).toContain('Unit  : $1,500.50');
  });
});

describe('solve', () => {
  it('settles a balanced game completely', () => {
    const players = [P('a', 20000, 46500), P('b', 30000, 8500), P('c', 10000, 29000), P('d', 20000, 0), P('e', 20000, 16000), P('f', 10000, 10000)];
    const audit = solve(players);
    expect(audit.isBalanced).toBe(true);
    expect(netAfter(players, audit, 0).every(v => v === 0)).toBe(true);
  });

  it('flags a discrepancy', () => {
    const audit = solve([P('a', 10000, 12000), P('b', 10000, 7000)]);
    expect(audit.discrepancyCents).toBe(-1000);
    expect(audit.isBalanced).toBe(false);
  });

  it('routes the expense pot to the house', () => {
    const players = [P('a', 10000, 9500), P('b', 10000, 10000)];
    const audit = solve(players, 500);
    expect(audit.isBalanced).toBe(true);
    expect(audit.transfers).toHaveLength(1);
    expect(audit.transfers[0].isHouse).toBe(true);
  });

  it('uses the minimum number of transfers (pairs that net out exactly)', () => {
    // Two independent 2-person groups: greedy-by-size would need 3, optimal is 2.
    const players = [P('a', 0, 5), P('b', 5, 0), P('c', 0, 3), P('d', 3, 0)].map(p => ({
      ...p, buyInCents: p.buyInCents * 100, cashOutCents: p.cashOutCents * 100
    }));
    expect(solve(players).transfers).toHaveLength(2);
  });

  it('never needs more than n-1 transfers and always clears balances', () => {
    const r = rng(7);
    for (let g = 0; g < 300; g++) {
      const n = 2 + Math.floor(r() * 11);
      const players = randomGame(r, n);
      const audit = solve(players);
      expect(audit.isBalanced).toBe(true);
      expect(audit.transfers.length).toBeLessThanOrEqual(n - 1);
      expect(netAfter(players, audit, 0).every(v => v === 0)).toBe(true);
    }
  });

  it('matches a brute-force minimum on small random games', () => {
    const r = rng(42);
    for (let g = 0; g < 200; g++) {
      const n = 2 + Math.floor(r() * 6);
      const players = randomGame(r, n);
      const nets = players.map(p => p.cashOutCents - p.buyInCents).filter(v => v !== 0);
      // brute force: max number of disjoint zero-sum subsets via recursion
      const maxGroups = (arr: number[]): number => {
        let best = 0;
        const rec = (mask: number, groups: number) => {
          if (mask === 0) { best = Math.max(best, groups); return; }
          const low = mask & -mask;
          for (let sub = mask; sub; sub = (sub - 1) & mask) {
            if (!(sub & low)) continue;
            let s = 0;
            for (let i = 0; i < arr.length; i++) if (sub & (1 << i)) s += arr[i];
            if (s === 0) rec(mask ^ sub, groups + 1);
          }
        };
        rec((1 << arr.length) - 1, 0);
        return best;
      };
      expect(solve(players).transfers.length).toBe(nets.length - maxGroups(nets));
    }
  });

  it('falls back to greedy above the exact limit and still settles', () => {
    const r = rng(3);
    const players = randomGame(r, 24);
    const audit = solve(players);
    expect(netAfter(players, audit, 0).every(v => v === 0)).toBe(true);
  });

  it('handles empty and zero-net tables', () => {
    expect(solve([]).transfers).toEqual([]);
    expect(settleNodes([])).toEqual([]);
    expect(solve([P('a', 100, 100)]).transfers).toEqual([]);
  });
});

describe('reconcile', () => {
  const modes = ['proRataWinners', 'equalSplit', 'topWinner'] as const;
  it.each(modes)('%s balances an overage and a shortage', mode => {
    const over = [P('a', 20000, 34000), P('b', 10000, 19500), P('c', 20000, 5000), P('d', 10000, 0)];
    expect(solve(reconcile(over, 0, mode)).isBalanced).toBe(true);
    const short = [P('a', 20000, 20000), P('b', 20000, 10000)];
    expect(solve(reconcile(short, 0, mode)).isBalanced).toBe(true);
  });

  it('never produces negative cash-outs and does not mutate the input', () => {
    const r = rng(11);
    for (let g = 0; g < 200; g++) {
      const players = randomGame(r, 2 + Math.floor(r() * 8));
      players[0].cashOutCents += Math.floor(r() * 20000) - 10000;
      players[0].cashOutCents = Math.max(0, players[0].cashOutCents);
      const copy = JSON.stringify(players);
      for (const mode of modes) {
        const out = reconcile(players, 0, mode);
        expect(out.every(p => p.cashOutCents >= 0)).toBe(true);
        expect(JSON.stringify(players)).toBe(copy);
      }
    }
  });

  it('respects the expense pot', () => {
    const players = [P('a', 10000, 15000), P('b', 10000, 5000)];
    const out = reconcile(players, 1000, 'proRataWinners');
    expect(solve(out, 1000).isBalanced).toBe(true);
  });
});

describe('backup parsing', () => {
  const session = { id: 's', name: 'Game', defaultBuyIn: 100, expenseCents: 0, isEnded: false, paid: {}, players: [P('a', 10000, 12000), P('b', 10000, 8000)] };

  it('round-trips the notepad backup', () => {
    const parsed = parseBackup(buildNotepad(session));
    expect(parsed?.kind).toBe('session');
    if (parsed?.kind === 'session') expect(parsed.session.players).toHaveLength(2);
  });

  it('rejects garbage', () => {
    expect(parseBackup('not json')).toBeNull();
    expect(parseBackup('{"players":"x"}')).toBeNull();
    expect(parseBackup('[]')).toBeNull();
  });

  it('sanitizes hostile values and duplicate ids', () => {
    const out = sanitizePlayers([
      { id: 'x', name: '<img src=x onerror=alert(1)>', buyInCents: -5, cashOutCents: 'NaN' },
      { id: 'x', name: '', buyInCents: 1e15, cashOutCents: 100.6 },
      null
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].buyInCents).toBe(0);
    expect(out[0].cashOutCents).toBe(0);
    expect(out[1].id).not.toBe(out[0].id);
    expect(out[1].name).toBe('Player');
    expect(out[1].buyInCents).toBeLessThanOrEqual(100_000_000);
    expect(out[1].cashOutCents).toBe(101);
  });
});

describe('leaderboard', () => {
  it('aggregates by case-insensitive name', () => {
    const rows = leaderboard([
      { id: '1', name: 'g1', timestamp: '', status: '', defaultBuyIn: 100, expenseCents: 0, players: [P('Al', 100, 300)] },
      { id: '2', name: 'g2', timestamp: '', status: '', defaultBuyIn: 100, expenseCents: 0, players: [P('al', 100, 0)] }
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessions: 2, netCents: 100 });
  });
});

describe('receipt and import regressions', () => {
  it('receipt marks paid transfers using the same key the UI stores', () => {
    const audit = solve([P('a', 10000, 15000), P('b', 10000, 5000)]);
    const t = audit.transfers[0];
    const text = buildReceipt('G', audit, { [paidKey(t.id, t.amountCents)]: true });
    expect(text).toContain('✅');
    expect(buildReceipt('G', audit, {})).not.toContain('✅');
  });

  it('makes duplicate session ids unique so open/delete are unambiguous', () => {
    const mk = (name: string) => ({ id: 'dup', name, timestamp: '', status: '', defaultBuyIn: 100, expenseCents: 0, players: [P('a', 1, 1)] });
    const ids = uniqueSessionIds([mk('1'), mk('2'), mk('3')]).map(s => s.id);
    expect(new Set(ids).size).toBe(3);
    const parsed = parseBackup(JSON.stringify([mk('1'), mk('2')]));
    expect(parsed?.kind === 'vault' && new Set(parsed.sessions.map(s => s.id)).size).toBe(2);
  });

  it('non-string player names become "Player", not [object Object]', () => {
    expect(sanitizePlayers([{ id: 'x', name: { a: 1 }, buyInCents: 1, cashOutCents: 1 }])[0].name).toBe('Player');
  });
});

describe('formatCurrency', () => {
  it('groups thousands and signs', () => {
    expect(formatCurrency(110000)).toBe('$1,100.00');
    expect(formatCurrency(-123456789, true)).toBe('-$1,234,567.89');
    expect(formatCurrency(5, true)).toBe('+$0.05');
    expect(formatCurrency(0)).toBe('$0.00');
    expect(toCents(formatCurrency(123456))).toBe(123456);
  });
});

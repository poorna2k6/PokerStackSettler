import { describe, expect, it } from 'vitest';
import {
  buildNotepad, buildReceipt, buyInCount, paidKey, uniqueSessionIds, formatUnit, leaderboard, parseBuyInUnit, sanitizeBuyIn, parseBackup, reconcile, sanitizePlayers, settleNodes, solve,
  formatCurrency, toCents, splitEvenly, sanitizeBills, roundToDollars, sanitizeSaved, chipRateCents, chipSummary, reconcileChips, sanitizeChipsPerBuyIn, MAX_BILL_CENTS, type Player
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
      { id: '1', name: 'g1', timestamp: '', status: 'Completed & Settled', defaultBuyIn: 100, expenseCents: 0, players: [P('Al', 100, 300)] },
      { id: '2', name: 'g2', timestamp: '', status: 'Completed & Settled', defaultBuyIn: 100, expenseCents: 0, players: [P('al', 100, 0)] }
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

describe('saved session paid marks', () => {
  it('keeps only true paid flags and survives a backup round trip', () => {
    const raw = { id: 's', name: 'G', players: [{ id: 'a', name: 'a', buyInCents: 1, cashOutCents: 1 }], paid: { 'a->b:100': true, 'x': false, 'y': 'yes' } };
    const parsed = parseBackup(JSON.stringify([raw]));
    expect(parsed?.kind === 'vault' && parsed.sessions[0].paid).toEqual({ 'a->b:100': true });
  });
});

describe('extra expenses (food, drinks)', () => {
  const pl = (id: string, bi: number, co: number) => ({ id, name: id.toUpperCase(), buyInCents: bi, cashOutCents: co });
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it('splits exactly, extra cents to the first players', () => {
    expect(splitEvenly(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEvenly(5, 0)).toEqual([]);
    expect(sum(splitEvenly(12345, 7))).toBe(12345);
  });

  it('settles food paid by a player and by an outsider, and nets to zero', () => {
    const players = [pl('a', 10000, 12000), pl('b', 10000, 8000)];
    const bills = [
      { id: '1', label: 'Pizza', cents: 3000, payerId: 'a' },
      { id: '2', label: 'Beer', cents: 1000, guest: 'Sam' }
    ];
    const a = solve(players, 0, 100, bills);
    expect(a.isBalanced).toBe(true); // expenses never touch the chip check
    expect(a.billsTotalCents).toBe(4000);
    expect(a.players.map(p => p.shareCents)).toEqual([2000, 2000]);
    expect(a.players[0].finalCents).toBe(2000 + 3000 - 2000);
    expect(a.players[1].finalCents).toBe(-2000 - 2000);
    expect(a.guests).toHaveLength(1);
    expect(a.guests[0].finalCents).toBe(1000);
    const moved = new Map<string, number>();
    for (const t of a.transfers) {
      moved.set(t.fromId, (moved.get(t.fromId) ?? 0) - t.amountCents);
      moved.set(t.toId, (moved.get(t.toId) ?? 0) + t.amountCents);
    }
    expect(moved.get('a') ?? 0).toBe(a.players[0].finalCents);
    expect(moved.get('b') ?? 0).toBe(a.players[1].finalCents);
    expect(moved.get('guest:sam') ?? 0).toBe(1000);
  });

  it('a guest typed with a player\'s name is that player', () => {
    const a = solve([pl('a', 100, 100), pl('b', 100, 100)], 0, 1, [{ id: 'x', label: 'Snacks', cents: 600, guest: ' a ' }]);
    expect(a.guests).toHaveLength(0);
    expect(a.players[0].paidCents).toBe(600);
  });

  it('is exact for random games (zero-sum, whole cents)', () => {
    let seed = 42;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let t = 0; t < 400; t++) {
      const n = 2 + rnd(9);
      const players = Array.from({ length: n }, (_, i) => pl(`p${i}`, 1000 + rnd(50000), 0));
      const pot = sum(players.map(p => p.buyInCents));
      let left = pot;
      players.forEach((p, i) => { p.cashOutCents = i === n - 1 ? left : rnd(left + 1); left -= p.cashOutCents; });
      const bills = Array.from({ length: rnd(5) }, (_, i) => ({ id: `b${i}`, label: 'x', cents: 1 + rnd(20000), ...(rnd(2) ? { payerId: `p${rnd(n)}` } : { guest: `G${rnd(3)}` }) }));
      const a = solve(players, 0, 100, bills);
      const finals = sum(a.players.map(p => p.finalCents)) + sum(a.guests.map(g => g.finalCents));
      expect(finals).toBe(0);
      const net = new Map<string, number>();
      for (const tr of a.transfers) {
        net.set(tr.fromId, (net.get(tr.fromId) ?? 0) - tr.amountCents);
        net.set(tr.toId, (net.get(tr.toId) ?? 0) + tr.amountCents);
      }
      for (const p of a.players) expect(net.get(p.id) ?? 0).toBe(p.finalCents);
      for (const g of a.guests) expect(net.get(g.id) ?? 0).toBe(g.finalCents);
    }
  });

  it('cleans hostile input and survives a notepad round trip', () => {
    const raw = [
      { id: 'a', label: 'x'.repeat(200), cents: 1e12, guest: 'G' },
      { cents: -5, guest: 'z' }, { cents: 'abc' }, null, 7,
      ...Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, label: 'l', cents: 100, guest: `g${i}` }))
    ];
    const clean = sanitizeBills(raw);
    expect(clean.length).toBeLessThanOrEqual(30);
    expect(new Set(clean.map(b => b.guest?.toLowerCase())).size).toBeLessThanOrEqual(8);
    expect(clean[0].label.length).toBe(40);
    expect(clean[0].cents).toBe(MAX_BILL_CENTS);
    const session = { id: 's', name: 'G', defaultBuyIn: 100, expenseCents: 0, isEnded: false, paid: {}, players: [pl('a', 10000, 10000), pl('b', 10000, 10000)], bills: [{ id: '1', label: 'Pizza', cents: 3000, payerId: 'a' }] };
    const text = buildNotepad(session);
    expect(text).toContain('EXTRA EXPENSES');
    const back = parseBackup(text);
    expect(back?.kind === 'session' && back.session.bills?.[0].cents).toBe(3000);
  });
});

describe('expense shared by a chosen list', () => {
  const pl = (id: string) => ({ id, name: id.toUpperCase(), buyInCents: 10000, cashOutCents: 10000 });
  it('splits only between the ticked people; payer need not be one of them', () => {
    const a = solve([pl('a'), pl('b'), pl('c')], 0, 100, [{ id: '1', label: 'Beer', cents: 1000, payerId: 'a', sharedBy: ['b', 'c'] }]);
    expect(a.players.map(p => p.shareCents)).toEqual([0, 500, 500]);
    expect(a.players.map(p => p.finalCents)).toEqual([1000, -500, -500]);
    expect(a.isBalanced).toBe(true);
  });
  it('mixes pooled and chosen expenses, and stays zero-sum', () => {
    const bills = [
      { id: '1', label: 'Pizza', cents: 3000, payerId: 'a' },
      { id: '2', label: 'Beer', cents: 1001, guest: 'Sam', sharedBy: ['b', 'guest:sam'] }
    ];
    const a = solve([pl('a'), pl('b'), pl('c')], 0, 100, bills);
    expect(a.players.map(p => p.shareCents)).toEqual([1000, 1000 + 501, 1000]);
    expect(a.guests[0].shareCents).toBe(500);
    const total = a.players.reduce((x, p) => x + p.finalCents, 0) + a.guests.reduce((x, g) => x + g.finalCents, 0);
    expect(total).toBe(0);
  });
  it('an unknown or empty list falls back to everyone, and ids are cleaned', () => {
    const a = solve([pl('a'), pl('b')], 0, 100, [{ id: '1', label: 'x', cents: 1000, payerId: 'a', sharedBy: ['ghost'] }]);
    expect(a.players.map(p => p.shareCents)).toEqual([500, 500]);
    expect(sanitizeBills([{ cents: 100, guest: 'g', sharedBy: ['a', 'a', 5, ''] }])[0].sharedBy).toEqual(['a']);
  });
});

describe('rounding payments to whole dollars', () => {
  it('keeps the total at zero and every amount within a dollar of the exact one', () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let t = 0; t < 500; t++) {
      const n = 2 + rnd(10);
      const nets = Array.from({ length: n - 1 }, () => rnd(20001) - 10000);
      nets.push(-nets.reduce((a, b) => a + b, 0));
      const r = roundToDollars(nets);
      expect(r.reduce((a, b) => a + b, 0)).toBe(0);
      r.forEach((v, i) => { expect(Math.abs(v % 100)).toBe(0); expect(Math.abs(v - nets[i])).toBeLessThan(100); });
    }
  });
  it('removes tiny payments and still pays everyone their dollar amount', () => {
    const P2 = (id: string, bi: number, co: number) => ({ id, name: id.toUpperCase(), buyInCents: bi, cashOutCents: co });
    const players = [P2('a', 10000, 10049), P2('b', 10000, 9951)];
    const exact = solve(players, 0, 100, []);
    expect(exact.transfers[0].amountCents).toBe(49);
    const rounded = solve(players, 0, 100, [], true);
    expect(rounded.transfers).toHaveLength(0);
    expect(rounded.isBalanced).toBe(true);
  });
  it('does nothing while the chips do not balance', () => {
    const P2 = (id: string, bi: number, co: number) => ({ id, name: id.toUpperCase(), buyInCents: bi, cashOutCents: co });
    const a = solve([P2('a', 10000, 20000), P2('b', 10000, 5000)], 0, 100, [], true);
    expect(a.isBalanced).toBe(false);
  });
});

describe('History keeps the whole-dollar choice', () => {
  it('round-trips through the saved session and the .txt backup', () => {
    const players = [{ id: 'a', name: 'A', buyInCents: 10000, cashOutCents: 10049 }, { id: 'b', name: 'B', buyInCents: 10000, cashOutCents: 9951 }];
    const saved = sanitizeSaved({ id: 's', name: 'G', defaultBuyIn: 100, expenseCents: 0, players, round: true });
    expect(saved?.round).toBe(true);
    expect(sanitizeSaved({ id: 's', name: 'G', players })?.round).toBe(false);
    const text = buildNotepad({ id: 's', name: 'G', defaultBuyIn: 100, expenseCents: 0, isEnded: false, paid: {}, players, round: true });
    expect(text).toContain('0 transfers');
    const back = parseBackup(text);
    expect(back?.kind === 'session' && back.session.round).toBe(true);
  });
});

describe('chip-count games (chips are not dollars)', () => {
  const pl = (id: string, buyIns: number, chips: number, unit = 1000, per = 40) => ({ id, name: id.toUpperCase(), buyInCents: buyIns * unit, cashOutCents: chips * (unit / per), cashOutChips: chips });

  it('a chip is worth a whole number of cents or the setup is refused', () => {
    expect(chipRateCents(10, 40)).toBe(25);
    expect(chipRateCents(10, 100)).toBe(10);
    expect(chipRateCents(10, 30)).toBeNull();   // 33.33 cents
    expect(chipRateCents(10, 0)).toBeNull();
    expect(chipRateCents(10, 2.5)).toBeNull();
    expect(chipRateCents(0, 40)).toBeNull();
    expect(sanitizeChipsPerBuyIn('40')).toBe(40);
    expect(sanitizeChipsPerBuyIn(-1)).toBeUndefined();
    expect(sanitizeChipsPerBuyIn(1e9)).toBeUndefined();
  });

  it('40 chips for $10: money is exactly chips x 25 cents', () => {
    const players = [pl('a', 2, 120), pl('b', 2, 40)];            // 80 chips each issued; a returns 120, b returns 40
    const s = chipSummary(players, 10, 40)!;
    expect(s.issued).toBe(160);
    expect(s.returned).toBe(160);
    expect(s.diff).toBe(0);
    expect(s.lines[0].valueCents).toBe(3000);                     // 120 chips x $0.25
    expect(s.lines[0].netCents).toBe(1000);                       // +$10
    const a = solve(players, 0, 10);
    expect(a.isBalanced).toBe(true);
    expect(a.transfers).toHaveLength(1);
    expect(a.transfers[0].amountCents).toBe(1000);
  });

  it('reports chips missing / too many, not dollars', () => {
    const missing = chipSummary([pl('a', 2, 100), pl('b', 2, 40)], 10, 40)!;
    expect(missing.diff).toBe(-20);
    const over = chipSummary([pl('a', 2, 150), pl('b', 2, 40)], 10, 40)!;
    expect(over.diff).toBe(30);
  });

  it('reconciling works on whole chips and always lands on exact money', () => {
    let seed = 99;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (const mode of ['proRataWinners', 'equalSplit', 'topWinner'] as const) {
      for (let t = 0; t < 150; t++) {
        const n = 2 + rnd(7);
        const players = Array.from({ length: n }, (_, i) => pl(`p${i}`, 1 + rnd(5), rnd(400)));
        const out = reconcileChips(players, 0, mode, 10, 40);
        const s = chipSummary(out, 10, 40)!;
        out.forEach(p => { expect(Number.isInteger(p.cashOutChips)).toBe(true); expect(p.cashOutChips!).toBeGreaterThanOrEqual(0); expect(p.cashOutCents).toBe(p.cashOutChips! * 25); });
        if (s.issued >= 0) expect(s.diff).toBe(0);
        expect(solve(out, 0, 10).isBalanced).toBe(true);
      }
    }
  });

  it('the notepad and receipt say chips and money', () => {
    const players = [pl('a', 2, 120), pl('b', 2, 40)];
    const text = buildNotepad({ id: 's', name: 'G', defaultBuyIn: 10, chipsPerBuyIn: 40, expenseCents: 0, isEnded: false, paid: {}, players });
    expect(text).toContain('40 chips per buy-in');
    expect(text).toContain('returned    120 chips = $30.00');
    const back = parseBackup(text);
    expect(back?.kind === 'session' && back.session.chipsPerBuyIn).toBe(40);
    expect(back?.kind === 'session' && back.session.players[0].cashOutChips).toBe(120);
    const receipt = buildReceipt('G', solve(players, 0, 10), {}, chipSummary(players, 10, 40));
    expect(receipt).toContain('120 chips back = $30.00');
  });
});

describe('fairer chip fixes', () => {
  const pl = (id: string, buyIns: number, chips: number) => ({ id, name: id, buyInCents: buyIns * 1000, cashOutCents: chips * 25, cashOutChips: chips });
  it('equal split spreads leftover chips one at a time, not all onto the last player', () => {
    const out = reconcileChips([pl('a', 1, 40), pl('b', 1, 40), pl('c', 1, 40), pl('d', 1, 30)], 0, 'equalSplit', 10, 40); // 10 chips short
    const added = out.map((p, i) => p.cashOutChips! - [40, 40, 40, 30][i]);
    expect(added.reduce((a, b) => a + b, 0)).toBe(10);
    expect(Math.max(...added) - Math.min(...added)).toBeLessThanOrEqual(1);
  });
  it('top winner never invents a winner out of a player who is not ahead', () => {
    const out = reconcileChips([pl('a', 1, 30), pl('b', 1, 30), pl('c', 1, 30), pl('d', 1, 30)], 0, 'topWinner', 10, 40); // 40 short, all behind
    expect(out.map(p => p.cashOutChips)).toEqual([40, 40, 40, 40]);
  });
  it('remembers what was typed when a count had to be adjusted', () => {
    const out = reconcileChips([pl('a', 2, 100), pl('b', 2, 60), pl('c', 1, 10), pl('d', 1, 0)], 0, 'proRataWinners', 10, 40);
    expect(out[0].typedChips).toBe(100);
    expect(out[0].cashOutChips).toBe(170);
    expect(out[2].typedChips).toBeUndefined(); // unchanged
  });
  it('rejects odd chip settings from storage', () => {
    expect(sanitizeChipsPerBuyIn(true)).toBeUndefined();
    expect(sanitizeChipsPerBuyIn([40])).toBeUndefined();
    expect(sanitizeChipsPerBuyIn('40abc')).toBeUndefined();
    expect(sanitizeChipsPerBuyIn(30, 10)).toBeUndefined(); // 33.33 cents
    expect(sanitizeChipsPerBuyIn(40, 10)).toBe(40);
  });
});

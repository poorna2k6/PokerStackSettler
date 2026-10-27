import { describe, expect, it } from 'vitest';
import { HAND_RANKS } from './handsData';

const ORDER = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
const value = (r: string) => 14 - ORDER.indexOf(r);

describe('hand ranking data', () => {
  it('lists the ten standard hands, strongest first, five cards each', () => {
    expect(HAND_RANKS.map(h => h.name)).toEqual([
      'Royal flush', 'Straight flush', 'Four of a kind', 'Full house', 'Flush',
      'Straight', 'Three of a kind', 'Two pair', 'One pair', 'High card'
    ]);
    for (const h of HAND_RANKS) expect(h.cards).toHaveLength(5);
  });

  it('each example really is the hand it claims to be', () => {
    const [royal, sFlush, quads, boat, flush, straight, trips, twoPair, pair] = HAND_RANKS.map(h => h.cards);
    const sameSuit = (cs: typeof royal) => cs.every(x => x.suit === cs[0].suit);
    const runs = (cs: typeof royal) => {
      const v = cs.map(x => value(x.rank)).sort((a, b) => b - a);
      return v.every((x, i) => i === 0 || v[i - 1] - x === 1);
    };
    const counts = (cs: typeof royal) => {
      const m = new Map<string, number>();
      cs.forEach(x => m.set(x.rank, (m.get(x.rank) ?? 0) + 1));
      return [...m.values()].sort((a, b) => b - a).join('');
    };
    expect(sameSuit(royal) && runs(royal) && royal[0].rank === 'A').toBe(true);
    expect(sameSuit(sFlush) && runs(sFlush)).toBe(true);
    expect(counts(quads)).toBe('41');
    expect(counts(boat)).toBe('32');
    expect(sameSuit(flush) && !runs(flush)).toBe(true);
    expect(runs(straight) && !sameSuit(straight)).toBe(true);
    expect(counts(trips)).toBe('311');
    expect(counts(twoPair)).toBe('221');
    expect(counts(pair)).toBe('2111');
  });

  it('cards that are not part of the made hand are flagged as kickers', () => {
    expect(HAND_RANKS[2].cards.filter(x => !x.counts)).toHaveLength(1); // quads + kicker
    expect(HAND_RANKS[0].cards.every(x => x.counts)).toBe(true);
  });
});

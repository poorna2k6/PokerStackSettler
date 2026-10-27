// Pure data for the hand-ranking cheat sheet (kept free of DOM code so it can be unit tested).

export type Suit = '♠' | '♥' | '♦' | '♣';
export interface CardFace { rank: string; suit: Suit; /** false = not part of the made hand (a "kicker") */ counts: boolean }
export interface HandRank { name: string; blurb: string; cards: CardFace[] }

const c = (rank: string, suit: Suit, counts = true): CardFace => ({ rank, suit, counts });

/** Strongest first. */
export const HAND_RANKS: HandRank[] = [
  { name: 'Royal flush', blurb: 'A K Q J 10, all the same suit. The best hand there is.',
    cards: [c('A', '♠'), c('K', '♠'), c('Q', '♠'), c('J', '♠'), c('10', '♠')] },
  { name: 'Straight flush', blurb: 'Five in a row, all the same suit.',
    cards: [c('9', '♥'), c('8', '♥'), c('7', '♥'), c('6', '♥'), c('5', '♥')] },
  { name: 'Four of a kind', blurb: 'Four cards of the same rank.',
    cards: [c('K', '♠'), c('K', '♥'), c('K', '♦'), c('K', '♣'), c('3', '♠', false)] },
  { name: 'Full house', blurb: 'Three of one rank plus a pair of another.',
    cards: [c('Q', '♠'), c('Q', '♥'), c('Q', '♦'), c('8', '♣'), c('8', '♠')] },
  { name: 'Flush', blurb: 'Any five cards of the same suit.',
    cards: [c('A', '♦'), c('J', '♦'), c('8', '♦'), c('5', '♦'), c('3', '♦')] },
  { name: 'Straight', blurb: 'Five in a row, any suits.',
    cards: [c('9', '♣'), c('8', '♦'), c('7', '♠'), c('6', '♥'), c('5', '♣')] },
  { name: 'Three of a kind', blurb: 'Three cards of the same rank.',
    cards: [c('7', '♠'), c('7', '♥'), c('7', '♦'), c('K', '♣', false), c('2', '♠', false)] },
  { name: 'Two pair', blurb: 'Two different pairs.',
    cards: [c('J', '♠'), c('J', '♥'), c('4', '♦'), c('4', '♣'), c('9', '♠', false)] },
  { name: 'One pair', blurb: 'Two cards of the same rank.',
    cards: [c('10', '♠'), c('10', '♥'), c('A', '♦', false), c('6', '♣', false), c('3', '♠', false)] },
  { name: 'High card', blurb: 'No hand at all — the highest card plays.',
    cards: [c('A', '♠', true), c('J', '♦', false), c('8', '♣', false), c('5', '♥', false), c('2', '♠', false)] }
];

export const HOW_A_HAND_GOES: { step: string; text: string }[] = [
  { step: 'Pre-flop', text: 'Everyone gets 2 private cards. Betting round.' },
  { step: 'Flop', text: '3 shared cards go face up. Betting round.' },
  { step: 'Turn', text: '1 more shared card. Betting round.' },
  { step: 'River', text: 'The last shared card. Final betting round.' },
  { step: 'Showdown', text: 'Best 5-card hand from your 2 + the 5 shared cards wins the pot.' }
];

export const GLOSSARY: { term: string; text: string }[] = [
  { term: 'Buy-in', text: 'The money you put on the table to get chips.' },
  { term: 'Rebuy', text: 'Buying more chips after you run low.' },
  { term: 'Pot', text: 'All the money being played for.' },
  { term: 'Cash out', text: 'Turning your chips back into money when you leave.' },
  { term: 'Net', text: 'Cash out minus buy-ins: what you won or lost.' }
];

export const isRed = (suit: Suit) => suit === '♥' || suit === '♦';

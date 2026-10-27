import type { Player } from './engine';

export interface Preset {
  key: string;
  label: string;
  sessionName: string;
  defaultBuyIn: number;
  expenseCents: number;
  players: Player[];
}

const mk = (id: string, name: string, bi: number, co: number): Player => ({
  id, name, buyInCents: bi * 100, cashOutCents: co * 100
});

export const PRESETS: Preset[] = [
  {
    key: 'friday6', label: 'Friday 6-Max', sessionName: 'Friday Night 6-Max', defaultBuyIn: 100, expenseCents: 0,
    players: [
      mk('p1', 'Alex (Host)', 200, 465), mk('p2', 'Marcus', 300, 85), mk('p3', 'Priya', 100, 290),
      mk('p4', 'Devon', 200, 0), mk('p5', 'Samir', 200, 160), mk('p6', 'Elena', 100, 100)
    ]
  },
  {
    key: 'club8', label: '$2/$5 Club (8p, rake)', sessionName: 'Deepstack $2/$5 Club', defaultBuyIn: 500, expenseCents: 5000,
    players: [
      mk('h1', 'Vikram', 1000, 1840), mk('h2', 'Chloe', 500, 920), mk('h3', 'Nate', 1000, 310),
      mk('h4', 'Sophia', 500, 0), mk('h5', 'Lucas', 500, 680), mk('h6', 'Karan', 500, 150),
      mk('h7', 'Noah', 500, 550), mk('h8', 'Aria', 500, 500)
    ]
  },
  {
    key: 'mismatch', label: 'Chip miscount demo', sessionName: 'Late Night Home Game', defaultBuyIn: 100, expenseCents: 0,
    players: [
      mk('d1', 'Jordan', 200, 340), mk('d2', 'Taylor', 100, 195), mk('d3', 'Casey', 200, 50), mk('d4', 'Morgan', 100, 0)
    ]
  },
  {
    key: 'micro', label: 'Micro-stakes ($25 buy-in)', sessionName: 'Dorm Micro-Stakes', defaultBuyIn: 25, expenseCents: 0,
    players: [
      mk('c1', 'Leo', 25, 61.75), mk('c2', 'Maya', 50, 18.15), mk('c3', 'Zack', 25, 39.1), mk('c4', 'Nina', 25, 6)
    ]
  }
];

// Small DOM builders shared by the host app and the read-only viewer.
import { h } from './dom';
import { formatCurrency, type Audit, type AuditPlayer } from './engine';

export const group = (...rows: (Node | null | false)[]) => h('div', { class: 'group' }, ...rows);
export const header = (title: string, caption?: string) =>
  h('div', { class: 'section-title', attrs: { role: 'heading', 'aria-level': 2 } }, h('span', { text: title }), caption ? h('span', { class: 'muted', text: caption }) : null);

export function kpi(label: string, value: string, sub?: string, tone = '') {
  return h('div', { class: `kpi ${tone}` },
    h('div', { class: 'kpi-label', text: label }),
    h('div', { class: 'kpi-value mono', text: value }),
    sub ? h('div', { class: 'kpi-sub mono', text: sub }) : null);
}

export const SUITS = ['♠', '♥', '♦', '♣'];
export const initial = (name: string) => (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();

export function avatar(i: number, name: string) {
  const suit = SUITS[i % 4];
  return h('span', { class: `avatar ${i % 4 === 1 || i % 4 === 2 ? 'red' : ''}`, attrs: { 'aria-hidden': 'true' } },
    h('b', { text: initial(name) }), h('i', { text: suit }));
}

/** A little stack of casino chips, one per buy-in (capped). */
export function chipStack(count: number, max = 6) {
  const n = Math.max(0, Math.min(max, Math.ceil(count)));
  return h('span', { class: 'chips', attrs: { 'aria-hidden': 'true' } },
    ...Array.from({ length: n }, (_, i) => h('i', { class: `chip-disc c${i % 5}` })));
}

/** The oval view only stays legible up to this many seats; beyond it callers fall back to a list. */
export const MAX_SEATS = 12;

export interface OvalOptions {
  a: Audit;
  /** accessible name of a seat */
  label: (p: AuditPlayer) => string;
  onSeat: (p: AuditPlayer) => void;
  /** optional small line under the name (e.g. "2x · $200.00") */
  note?: (p: AuditPlayer) => string;
  hint: string;
  /** seat to draw with a highlight ring ("that's me") */
  highlightId?: string;
}

export function ovalTable({ a, label, onSeat, note, hint, highlightId }: OvalOptions) {
  const n = a.players.length;
  const topId = [...a.players].sort((x, y) => y.netCents - x.netCents)[0]?.id;
  const oval = h('div', { class: `oval ${n > 9 ? 'tiny' : ''}` },
    h('div', { class: 'oval-center' },
      h('div', { class: 'kpi-label', text: 'Pot' }),
      h('div', { class: 'mono pot', text: formatCurrency(a.totalBuyInCents) }),
      chipStack(a.totalBuyInCount, 8)));
  a.players.forEach((p, i) => {
    const ang = Math.PI / 2 + (2 * Math.PI * i) / n;
    const seat = h('button', { class: `seat ${p.id === highlightId ? 'me' : ''}`, attrs: { 'aria-label': label(p) }, on: { click: () => onSeat(p) } },
      avatar(i, p.name),
      i === 0 ? h('span', { class: 'dealer', text: 'D', attrs: { 'aria-hidden': 'true' } }) : null,
      h('span', { class: 'seat-name', text: p.name }),
      note ? h('span', { class: 'seat-in mono', text: note(p) }) : null,
      h('span', { class: `seat-net mono ${p.netCents > 0 ? 'good' : p.netCents < 0 ? 'bad' : 'muted'}`, text: formatCurrency(p.netCents, true) }),
      p.id === topId && p.netCents > 0 ? h('span', { class: 'crown', text: '👑', attrs: { 'aria-hidden': 'true' } }) : null);
    seat.style.left = `${50 + 41 * Math.cos(ang)}%`;
    seat.style.top = `${50 + 41 * Math.sin(ang)}%`;
    oval.append(seat);
  });
  return h('div', { class: 'oval-wrap' }, oval, h('div', { class: 'foot', text: hint }));
}


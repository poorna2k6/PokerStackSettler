// Small DOM builders shared by the host app and the read-only viewer.
import { h } from './dom';

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

// The "How hands rank" cheat sheet for newcomers. Cards are drawn with DOM/CSS (no image files), so it
// works offline, scales with the screen and follows the theme.
import { h, openSheet } from './dom';
import { GLOSSARY, HAND_RANKS, HOW_A_HAND_GOES, isRed, type CardFace } from './handsData';

function pcard(card: CardFace) {
  return h('span', { class: `pcard ${isRed(card.suit) ? 'red' : ''} ${card.counts ? '' : 'dim'}`, attrs: { 'aria-hidden': 'true' } },
    h('b', { text: card.rank }), h('i', { text: card.suit }));
}

export function openHandsSheet() {
  openSheet('How hands rank', close => {
    const total = HAND_RANKS.length;
    const ranks = HAND_RANKS.map((hand, i) =>
      h('li', { class: 'hand-row' },
        h('div', { class: 'hand-head' },
          h('span', { class: 'hand-no', text: String(i + 1) }),
          h('strong', { text: hand.name }),
          h('span', { class: 'hand-bar', attrs: { 'aria-hidden': 'true' } },
            h('i', { attrs: { style: `width:${Math.round(((total - i) / total) * 100)}%` } }))),
        h('div', { class: 'hand-cards', attrs: { role: 'img', 'aria-label': `${hand.name}: ${hand.cards.map(c => c.rank + c.suit).join(' ')}` } },
          ...hand.cards.map(pcard)),
        h('p', { class: 'muted small', text: hand.blurb })));

    return h('div', { class: 'sheet-body hands-sheet' },
      h('p', { class: 'muted small', text: 'Strongest at the top. Bright cards make the hand; faded cards are just extras.' }),
      h('ol', { class: 'hand-list' }, ...ranks),
      h('h3', { class: 'hands-h', text: 'How a hand goes' }),
      h('ol', { class: 'flow' }, ...HOW_A_HAND_GOES.map(s => h('li', {}, h('strong', { text: s.step }), h('span', { class: 'muted', text: ` — ${s.text}` })))),
      h('h3', { class: 'hands-h', text: 'Words you’ll hear' }),
      h('dl', { class: 'gloss' }, ...GLOSSARY.flatMap(g => [h('dt', { text: g.term }), h('dd', { class: 'muted', text: g.text })])),
      h('button', { class: 'btn primary block', text: 'Got it', on: { click: close } }));
  });
}

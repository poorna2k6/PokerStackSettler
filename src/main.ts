import '@fontsource/playfair-display/latin-700.css';
import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { h, haptic, openSheet, confirmSheet, toast } from './dom';
import { clink, setSoundEnabled } from './sound';
import {
  buildReceipt, formatBuyInCount, formatUnit, MAX_UNIT, MIN_UNIT, type Audit, formatCurrency, leaderboard, toCents, unitCentsFor,
  type SavedSession
} from './engine';
import { PRESETS } from './presets';
import { THEMES, type Theme } from './storage';
import {
  addPlayer, applyReconcile, audit, clearHistory, deleteSaved, endSession, importBackup, loadSaved,
  newSession, paidKey, rebuy, removePlayer, reopenSession, saveToHistory, sessionText, setExpense,
  setName, setPrefs, setTab, setTheme, setUnit, state, subscribe, togglePaid, updatePlayer, type Tab
} from './state';

registerSW({ immediate: true });

const THEME_COLORS: Record<Theme, string> = { midnight: '#000000', felt: '#0a3d2a', ocean: '#06182c', light: '#f2f2f7' };
setSoundEnabled(state.prefs.sound);
let animateSettle = false;
const money = (c: number) => (c / 100).toFixed(2);
const unitError = () => toast(`Buy-in unit must be between ${formatUnit(MIN_UNIT)} and ${formatUnit(MAX_UNIT)}`, 'error');
const changeUnit = (v: string) => { if (!setUnit(v)) unitError(); };

// ---------------------------------------------------------------- helpers

function download(filename: string, content: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { attrs: { href: url, download: filename } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const safeFile = (s: string) => s.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) || 'session';

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    const ta = h('textarea', { attrs: { readonly: true } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    toast(ok ? 'Copied to clipboard' : 'Could not copy', ok ? 'ok' : 'error');
  }
}

const group = (...rows: (Node | null | false)[]) => h('div', { class: 'group' }, ...rows);
const header = (title: string, caption?: string) =>
  h('div', { class: 'section-title' }, h('span', { text: title }), caption ? h('span', { class: 'muted', text: caption }) : null);

function field(label: string, input: HTMLInputElement) {
  return h('label', { class: 'row field' }, h('span', { text: label }), input);
}

function textInput(value: string, onChange: (v: string) => void, opts: { disabled?: boolean; mode?: string; placeholder?: string; label?: string } = {}) {
  const el = h('input', {
    attrs: {
      type: 'text', inputmode: opts.mode, value, placeholder: opts.placeholder, disabled: opts.disabled,
      'aria-label': opts.label, autocomplete: 'off', autocapitalize: opts.mode ? 'off' : 'words', enterkeyhint: 'done'
    },
    on: { change: () => onChange(el.value), focus: () => el.select() }
  });
  el.value = value;
  return el;
}

// ---------------------------------------------------------------- views

function startFresh() {
  newSession();
  toast('Fresh table ready — add your players');
  openAddPlayer();
}

function requestNew() {
  const s = state.session;
  if (s.isDemo || s.players.length === 0) { startFresh(); return; }
  confirmSheet({
    title: 'Start a new session?',
    message: s.isEnded
      ? 'The current settled session stays in History.'
      : 'The current table will be replaced. Save it to History first if you need it.',
    confirmLabel: 'Start new session', destructive: !s.isEnded, onConfirm: startFresh
  });
}

function tableView(): HTMLElement {
  const s = state.session;
  const a = audit();
  const locked = s.isEnded;
  const view = h('div', { class: 'view' });

  if (s.isDemo) {
    view.append(h('div', { class: 'demo-card' },
      h('div', { class: 'grow' },
        h('strong', { text: '🎲 Demo mode' }),
        h('div', { class: 'small', text: 'You’re looking at sample data. It is never saved to History.' })),
      h('button', { class: 'btn primary', text: 'Start fresh', on: { click: startFresh } })));
  }

  view.append(
    h('div', { class: 'kpis' },
      kpi('Players', String(a.players.length)),
      kpi('Pot', formatCurrency(a.totalBuyInCents), `${a.totalBuyInCount} buy-in${a.totalBuyInCount === 1 ? '' : 's'}`),
      kpi('Chips out', formatCurrency(a.totalAccountedCents), a.isBalanced ? 'Balanced ✓' : formatCurrency(a.discrepancyCents, true), a.isBalanced ? 'good' : 'warn'))
  );

  if (locked) {
    view.append(group(h('div', { class: 'row banner info' },
      h('span', { text: '🔒 Session settled and locked' }),
      h('button', { class: 'link', text: 'Reopen', on: { click: () => confirmSheet({
        title: 'Reopen session?', message: 'Editing will be enabled again. You can settle it again afterwards.',
        confirmLabel: 'Reopen', onConfirm: reopenSession }) } }))));
  } else if (!a.isBalanced && a.players.length > 0) {
    const over = a.discrepancyCents > 0;
    view.append(
      h('div', { class: 'group warn-card' },
        h('div', { class: 'row banner' },
          h('strong', { text: `${formatCurrency(Math.abs(a.discrepancyCents))} ${over ? 'too many' : 'missing'}` }),
          h('span', { class: 'muted', text: 'Ending chips ≠ buy-ins' })),
        h('div', { class: 'seg-row' },
          h('button', { class: 'chip', text: 'Pro-rata', on: { click: () => applyReconcile('proRataWinners') } }),
          h('button', { class: 'chip', text: 'Equal split', on: { click: () => applyReconcile('equalSplit') } }),
          h('button', { class: 'chip', text: 'Top winner', on: { click: () => applyReconcile('topWinner') } })))
    );
  }

  const seg = h('div', { class: 'segmented', attrs: { role: 'tablist', 'aria-label': 'Player view' } },
    ...(['list', 'table'] as const).map(v => h('button', {
      text: v === 'list' ? 'List' : 'Table',
      attrs: { role: 'tab', 'aria-selected': state.prefs.view === v },
      class: state.prefs.view === v ? 'on' : '',
      on: { click: () => setPrefs({ view: v }) }
    })));
  view.append(h('div', { class: 'players-head' }, h('span', { class: 'section-inline', text: `Players · ${formatUnit(s.defaultBuyIn)}/buy-in` }), seg));

  if (s.players.length === 0) {
    view.append(group(h('div', { class: 'row empty' }, h('span', { text: 'No players yet — add the first seat.' }))));
  } else if (state.prefs.view === 'table') {
    view.append(seatsView(a, locked));
  } else {
    view.append(group(...a.players.map((p, i) => playerRow(i, p.id, p.name, p.buyInCents, p.cashOutCents, p.buyInCount, p.netCents, locked))));
  }
  if (!locked) {
    view.append(h('button', { class: 'btn tinted block', text: '＋ Add player', on: { click: openAddPlayer } }));
  }

  view.append(header('Session'));
  view.append(group(
    field('Name', textInput(s.name, setName, { disabled: locked, label: 'Session name' })),
    field('Buy-in unit ($)', textInput(String(s.defaultBuyIn), changeUnit, { disabled: locked, mode: 'decimal', label: 'Buy-in unit' })),
    field('Rake / expense ($)', textInput(money(s.expenseCents), setExpense, { disabled: locked, mode: 'decimal', label: 'Expense pot' }))
  ));

  view.append(
    h('button', {
      class: 'btn primary block', text: locked ? 'View settlement' : 'End & settle',
      attrs: { disabled: s.players.length < 2 && !locked },
      on: { click: locked ? () => setTab('settle') : requestEnd }
    }),
    ...(s.players.length < 2 && !locked ? [h('div', { class: 'foot', text: 'Add at least 2 players to settle' })] : []),
    h('div', { class: 'foot' }, storageNote())
  );
  return view;
}

const SUITS = ['♠', '♥', '♦', '♣'];
const initial = (name: string) => (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();

function avatar(i: number, name: string) {
  const suit = SUITS[i % 4];
  return h('span', { class: `avatar ${i % 4 === 1 || i % 4 === 2 ? 'red' : ''}`, attrs: { 'aria-hidden': 'true' } },
    h('b', { text: initial(name) }), h('i', { text: suit }));
}

/** A little stack of casino chips, one per buy-in (capped). */
function chipStack(count: number, max = 6) {
  const n = Math.max(0, Math.min(max, Math.ceil(count)));
  return h('span', { class: 'chips', attrs: { 'aria-hidden': 'true' } },
    ...Array.from({ length: n }, (_, i) => h('i', { class: `chip-disc c${i % 5}` })));
}

function seatsView(a: Audit, locked: boolean) {
  const n = a.players.length;
  const topId = [...a.players].sort((x, y) => y.netCents - x.netCents)[0]?.id;
  const oval = h('div', { class: `oval ${n > 9 ? 'tiny' : ''}` },
    h('div', { class: 'oval-center' },
      h('div', { class: 'kpi-label', text: 'Pot' }),
      h('div', { class: 'mono pot', text: formatCurrency(a.totalBuyInCents) }),
      chipStack(a.totalBuyInCount, 8)));
  a.players.forEach((p, i) => {
    const ang = Math.PI / 2 + (2 * Math.PI * i) / n;
    const seat = h('button', {
      class: 'seat',
      attrs: { 'aria-label': `${p.name}: ${formatBuyInCount(p.buyInCount)} in, net ${formatCurrency(p.netCents, true)}. Tap to edit.` },
      on: { click: () => openPlayerSheet(p.id) }
    },
      avatar(i, p.name),
      i === 0 ? h('span', { class: 'dealer', text: 'D', attrs: { 'aria-hidden': 'true' } }) : null,
      h('span', { class: 'seat-name', text: p.name }),
      h('span', { class: `seat-net mono ${p.netCents > 0 ? 'good' : p.netCents < 0 ? 'bad' : 'muted'}`, text: formatCurrency(p.netCents, true) }),
      p.id === topId && p.netCents > 0 ? h('span', { class: 'crown', text: '👑', attrs: { 'aria-hidden': 'true' } }) : null);
    seat.style.left = `${50 + 41 * Math.cos(ang)}%`;
    seat.style.top = `${50 + 41 * Math.sin(ang)}%`;
    oval.append(seat);
  });
  return h('div', { class: 'oval-wrap' }, oval,
    h('div', { class: 'foot', text: locked ? 'Tap a seat to view details' : 'Tap a seat to edit buy-ins and chips' }));
}

function storageNote() {
  return state.storageOk
    ? `✓ Auto-saved on this device${state.lastSave ? ' · ' + state.lastSave : ''}`
    : '⚠️ Storage is blocked — changes will be lost when you close this page. Use Export to keep a copy.';
}

function kpi(label: string, value: string, sub?: string, tone = '') {
  return h('div', { class: `kpi ${tone}` },
    h('div', { class: 'kpi-label', text: label }),
    h('div', { class: 'kpi-value mono', text: value }),
    sub ? h('div', { class: 'kpi-sub mono', text: sub }) : null);
}

function stepper(id: string, buyIn: number, count: number, locked: boolean, after?: () => void) {
  const unit = unitCentsFor(state.session.defaultBuyIn);
  const bump = (d: number) => () => { haptic(); clink(); rebuy(id, d); after?.(); };
  return h('div', { class: 'stepper' },
    h('button', { text: '−', attrs: { 'aria-label': 'Remove one buy-in', disabled: locked || buyIn < unit }, on: { click: bump(-1) } }),
    h('span', { class: 'mono', text: `${formatBuyInCount(count)} · ${formatCurrency(buyIn)}` }),
    h('button', { text: '+', attrs: { 'aria-label': 'Add one buy-in', disabled: locked }, on: { click: bump(1) } }));
}

function confirmRemove(id: string, name: string, after?: () => void) {
  confirmSheet({
    title: `Remove ${name}?`, message: 'Their buy-ins and chips will be deleted from this session.',
    confirmLabel: 'Remove', destructive: true, onConfirm: () => { removePlayer(id); after?.(); }
  });
}

function playerRow(i: number, id: string, name: string, buyIn: number, cashOut: number, count: number, net: number, locked: boolean) {
  const nameInput = textInput(name, v => updatePlayer(id, { name: v.trim().slice(0, 40) || 'Player' }), { disabled: locked, label: 'Player name' });
  nameInput.classList.add('player-name');
  const cash = textInput(money(cashOut), v => updatePlayer(id, { cashOutCents: Math.max(0, toCents(v)) }), { disabled: locked, mode: 'decimal', label: `${name} ending chips` });
  cash.classList.add('mono');
  const tone = net > 0 ? 'good' : net < 0 ? 'bad' : 'muted';
  return h('div', { class: 'row player' },
    h('div', { class: 'player-top' },
      avatar(i, name),
      nameInput,
      chipStack(count),
      h('span', { class: `net mono ${tone}`, text: formatCurrency(net, true) }),
      locked ? null : h('button', { class: 'icon-btn', text: '✕', attrs: { 'aria-label': `Remove ${name}` }, on: { click: () => confirmRemove(id, name) } })),
    h('div', { class: 'player-bottom' },
      stepper(id, buyIn, count, locked),
      h('label', { class: 'cash' }, h('span', { class: 'muted', text: '$', attrs: { 'aria-hidden': 'true' } }), cash)));
}

/** Edit sheet used from the oval-table view. Redraws itself after every change. */
function openPlayerSheet(id: string) {
  openSheet('Player', close => {
    const body = h('div', { class: 'sheet-body' });
    const draw = () => {
      const p = audit().players.find(x => x.id === id);
      if (!p) { close(); return; }
      const locked = state.session.isEnded;
      const name = textInput(p.name, v => { updatePlayer(id, { name: v.trim().slice(0, 40) || 'Player' }); draw(); }, { disabled: locked, label: 'Player name' });
      const cash = textInput(money(p.cashOutCents), v => { updatePlayer(id, { cashOutCents: Math.max(0, toCents(v)) }); draw(); }, { disabled: locked, mode: 'decimal', label: 'Ending chips' });
      cash.classList.add('mono');
      body.replaceChildren(
        group(field('Name', name), field('Ending chips ($)', cash)),
        h('div', { class: 'sheet-stepper' }, chipStack(p.buyInCount, 8), stepper(id, p.buyInCents, p.buyInCount, locked, draw)),
        h('div', { class: 'row banner' }, h('span', { class: 'muted', text: 'Net result' }),
          h('strong', { class: `mono ${p.netCents > 0 ? 'good' : p.netCents < 0 ? 'bad' : 'muted'}`, text: formatCurrency(p.netCents, true) })),
        ...(locked ? [] : [h('button', { class: 'btn danger block', text: 'Remove player', on: { click: () => { close(); confirmRemove(id, p.name); } } })])
      );
    };
    draw();
    return body;
  });
}

function openAddPlayer() {
  openSheet('Add player', close => {
    const name = h('input', { attrs: { type: 'text', placeholder: 'Name', autocapitalize: 'words', autocomplete: 'off', 'aria-label': 'New player name', enterkeyhint: 'done' } });
    const count = h('input', { attrs: { type: 'text', inputmode: 'decimal', value: '1', 'aria-label': 'Number of buy-ins' } });
    const countLabel = h('span', { text: `Buy-ins (× ${formatUnit(state.session.defaultBuyIn)})` });
    // On an empty table the unit can be chosen up front, before any buy-in is entered.
    const unit = state.session.players.length === 0 && !state.session.isEnded
      ? textInput(String(state.session.defaultBuyIn), v => { changeUnit(v); countLabel.textContent = `Buy-ins (× ${formatUnit(state.session.defaultBuyIn)})`; }, { mode: 'decimal', label: 'Buy-in unit' })
      : null;
    const submit = (keepOpen: boolean) => {
      const n = parseFloat(count.value);
      addPlayer(name.value, Number.isFinite(n) ? n : 1);
      haptic();
      if (keepOpen) { name.value = ''; count.value = '1'; name.focus(); } else close();
    };
    name.addEventListener('keydown', e => { if (e.key === 'Enter') submit(true); });
    return h('div', { class: 'sheet-body' },
      group(...(unit ? [field('Buy-in unit ($)', unit)] : []), field('Name', name), h('label', { class: 'row field' }, countLabel, count)),
      h('button', { class: 'btn primary block', text: 'Add & finish', on: { click: () => submit(false) } }),
      h('button', { class: 'btn tinted block', text: 'Add & next player', on: { click: () => submit(true) } }));
  });
}

function finishSession() {
  if (endSession()) { setTab('settle'); toast('Session settled'); }
  else toast('Can’t balance this table — check the rake/expense amount', 'error');
}

function requestEnd() {
  const a = audit();
  if (a.players.length < 2) { toast('Add at least 2 players to settle', 'error'); return; }
  if (!a.isBalanced) {
    confirmSheet({
      title: `Chips are ${formatCurrency(Math.abs(a.discrepancyCents))} ${a.discrepancyCents < 0 ? 'short' : 'over'}`,
      message: `Ending chips (${formatCurrency(a.totalAccountedCents)}) don't match buy-ins (${formatCurrency(a.totalBuyInCents)}).\n\nContinuing will adjust payouts so the table balances (pro-rata among winners when there are any), then lock the session.`,
      confirmLabel: 'Balance & settle', onConfirm: finishSession
    });
    return;
  }
  confirmSheet({
    title: 'End & settle?',
    message: `${a.players.length} players · ${formatCurrency(a.totalBuyInCents)} pot · ${a.transfers.length} transfer${a.transfers.length === 1 ? '' : 's'}.\n\n${state.session.isDemo ? 'This is demo data, so it won’t be saved to History. The session will be locked.' : 'The session will be saved to History and locked.'}`,
    confirmLabel: 'End session', onConfirm: finishSession
  });
}

function settleView(): HTMLElement {
  const s = state.session;
  const a = audit();
  const view = h('div', { class: 'view' });
  if (s.isDemo) view.append(h('div', { class: 'demo-card' }, h('div', { class: 'grow' }, h('strong', { text: '🎲 Demo mode' }), h('div', { class: 'small', text: 'Sample data — not saved to History.' })), h('button', { class: 'btn primary', text: 'Start fresh', on: { click: startFresh } })));
  const paidCount = a.transfers.filter(t => s.paid[paidKey(t.id, t.amountCents)]).length;

  view.append(h('div', { class: 'kpis' },
    kpi('Transfers', String(a.transfers.length)),
    kpi('Paid', `${paidCount}/${a.transfers.length}`, undefined, paidCount === a.transfers.length && a.transfers.length ? 'good' : ''),
    kpi('Pot', formatCurrency(a.totalBuyInCents))));

  if (!a.isBalanced) {
    view.append(group(h('div', { class: 'row banner' },
      h('strong', { text: `⚠️ Off by ${formatCurrency(a.discrepancyCents, true)}` }),
      h('button', { class: 'link', text: 'Fix on Table', on: { click: () => setTab('table') } }))));
  }

  view.append(header('Who pays whom', a.transfers.length ? 'tap to mark paid' : ''));
  if (a.transfers.length === 0 || !a.isBalanced || a.players.length < 2) {
    const msg = a.players.length < 2 ? 'Add at least 2 players to see payments'
      : !a.isBalanced ? 'Fix the chip mismatch to see payments'
      : 'No payments needed 🎉';
    view.append(group(h('div', { class: 'row empty' }, h('span', { text: msg }))));
  } else {
    view.append(group(...a.transfers.map((t, ti) => {
      const key = paidKey(t.id, t.amountCents);
      const paid = Boolean(s.paid[key]);
      return h('button', {
        class: `row transfer ${paid ? 'paid' : ''} ${animateSettle ? 'enter' : ''}`,
        attrs: { role: 'checkbox', 'aria-checked': paid, 'aria-label': `${t.fromName} pays ${t.toName} ${formatCurrency(t.amountCents)}` },
        on: { click: () => { haptic(); clink(); togglePaid(key); } }
      },
        h('i', { class: `chip-disc fly c${ti % 5}`, attrs: { 'aria-hidden': 'true', style: `--d:${ti * 90}ms` } }),
        h('span', { class: `check ${paid ? 'on' : ''}`, text: '✓' }),
        h('span', { class: 'who' },
          h('span', { class: 'bad', text: t.fromName }), h('span', { class: 'muted', text: ' pays ' }),
          h('span', { class: t.isHouse ? 'house' : 'good', text: t.toName })),
        h('span', { class: 'mono amt', text: formatCurrency(t.amountCents) }));
    })));
  }

  view.append(header('Standings'));
  const sorted = [...a.players].sort((x, y) => y.netCents - x.netCents);
  view.append(group(...sorted.map((p, i) => h('div', { class: `row standing ${i === 0 && p.netCents > 0 ? 'gold' : ''}` },
    h('span', { class: 'rank', text: i === 0 && p.netCents > 0 ? '🏆' : String(i + 1) }),
    h('span', { class: 'grow', text: p.name }),
    h('span', { class: 'muted mono', text: formatBuyInCount(p.buyInCount) }),
    h('span', { class: `mono ${p.netCents > 0 ? 'good' : p.netCents < 0 ? 'bad' : 'muted'}`, text: formatCurrency(p.netCents, true) })))));

  const receipt = () => buildReceipt(s.name, a, s.paid);
  if (a.players.length === 0) return view;
  view.append(
    h('button', { class: 'btn primary block', text: 'Share / copy receipt', on: { click: async () => {
      const text = receipt();
      if (navigator.share) { try { await navigator.share({ title: s.name, text }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; } }
      copyText(text);
    } } }),
    h('div', { class: 'two' },
      h('button', { class: 'btn tinted', text: 'Save to history', on: { click: () => { if (saveToHistory(s.isEnded ? 'Completed & Settled' : 'Saved Snapshot')) toast('Saved to History'); else toast('Demo sessions aren’t saved — start a fresh session', 'error'); } } }),
      h('button', { class: 'btn tinted', text: 'Download .txt', on: { click: () => download(`${safeFile(s.name)}_settlement.txt`, sessionText(s)) } })),
    ...(s.isEnded ? [] : [h('button', { class: 'btn plain block', text: 'End & settle…', attrs: { disabled: a.players.length < 2 }, on: { click: requestEnd } })])
  );
  return view;
}

function historyView(): HTMLElement {
  const view = h('div', { class: 'view' });
  const rows = leaderboard(state.saved);

  view.append(header('Lifetime leaderboard', rows.length ? `${state.saved.length} sessions` : ''));
  view.append(rows.length
    ? group(...rows.map((r, i) => h('div', { class: 'row standing' },
        h('span', { class: 'rank', text: i === 0 && r.netCents > 0 ? '🏆' : String(i + 1) }),
        h('span', { class: 'grow' }, r.name, h('div', { class: 'muted small', text: `${r.sessions} session${r.sessions === 1 ? '' : 's'}` })),
        h('span', { class: `mono ${r.netCents > 0 ? 'good' : r.netCents < 0 ? 'bad' : 'muted'}`, text: formatCurrency(r.netCents, true) }))))
    : group(h('div', { class: 'row empty' }, h('span', { text: 'Save or settle a session to see lifetime stats.' }))));

  view.append(header('Saved sessions'));
  view.append(state.saved.length
    ? group(...state.saved.map(s => {
        const net = s.players.reduce((acc, p) => acc + p.buyInCents, 0);
        return h('button', { class: 'row session', on: { click: () => openSavedActions(s) } },
          h('span', { class: 'grow' }, h('strong', { text: s.name }), h('div', { class: 'muted small', text: `${s.timestamp} · ${s.players.length} players · ${s.status}` })),
          h('span', { class: 'mono', text: formatCurrency(net) }),
          h('span', { class: 'chev', text: '›' }));
      }))
    : group(h('div', { class: 'row empty' }, h('span', { text: 'Nothing saved yet.' }))));
  return view;
}

function openSavedActions(s: SavedSession) {
  openSheet(s.name, close => h('div', { class: 'sheet-body' },
    h('p', { class: 'muted', text: `${s.timestamp} · ${s.players.length} players · ${s.status}` }),
    h('button', { class: 'btn primary block', text: 'Open on Table', on: { click: () => { close(); loadSaved(s.id); } } }),
    h('button', { class: 'btn tinted block', text: 'Download .txt', on: { click: () => { close(); download(`${safeFile(s.name)}_notepad.txt`, sessionText(s)); } } }),
    h('button', { class: 'btn danger block', text: 'Delete', on: { click: () => { close(); confirmSheet({
      title: `Delete “${s.name}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', destructive: true, onConfirm: () => deleteSaved(s.id) }); } } })));
}

function settingsView(): HTMLElement {
  const view = h('div', { class: 'view' });
  const swatch: Record<Theme, string> = { midnight: '#0b1220', felt: '#0d4a33', ocean: '#0b3b66', light: '#f2f2f7' };

  view.append(header('Appearance'));
  view.append(h('div', { class: 'themes' }, ...THEMES.map(t => h('button', {
    class: `theme ${state.theme === t ? 'on' : ''}`,
    attrs: { 'aria-pressed': state.theme === t, 'aria-label': `${t} theme` },
    on: { click: () => setTheme(t) }
  }, h('span', { class: 'dot', attrs: { style: `background:${swatch[t]}` } }), h('span', { text: t[0].toUpperCase() + t.slice(1) })))));

  view.append(header('Sound & feel'));
  view.append(group(h('button', {
    class: 'row action', attrs: { role: 'switch', 'aria-checked': state.prefs.sound },
    on: { click: () => { const on = !state.prefs.sound; setSoundEnabled(on); setPrefs({ sound: on }); clink(); } }
  }, h('span', { class: 'grow', text: 'Chip sounds' }), h('span', { class: `switch ${state.prefs.sound ? 'on' : ''}` }, h('i')))));

  view.append(header('Sessions'));
  view.append(group(h('button', { class: 'row action', on: { click: requestNew } },
    h('span', { class: 'grow', text: '＋ Start a fresh session' }), h('span', { class: 'muted', text: '›' }))));

  view.append(header('Try a demo', 'sample data, never saved'));
  view.append(group(...PRESETS.map(p => h('button', { class: 'row action', on: { click: () => confirmNew(() => { newSession(p); toast('Demo loaded'); }) } },
    h('span', { class: 'grow', text: p.label }), h('span', { class: 'muted small', text: `${p.players.length} players` })))));

  view.append(header('Data', state.storageOk ? 'stored on this device' : 'storage blocked'));
  const file = h('input', { attrs: { type: 'file', accept: '.txt,.json,text/plain,application/json', hidden: true }, on: { change: () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 5_000_000) { toast('File is too large', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const msg = importBackup(String(reader.result ?? ''));
      toast(msg ?? 'That file is not a StackSettle backup', msg ? 'ok' : 'error');
    };
    reader.readAsText(f);
    file.value = '';
  } } });
  view.append(group(
    h('button', { class: 'row action', text: 'Import backup (.txt / .json)', on: { click: () => file.click() } }),
    h('button', { class: 'row action', text: 'Export current session (.txt)', on: { click: () => download(`${safeFile(state.session.name)}_notepad.txt`, sessionText(state.session)) } }),
    h('button', { class: 'row action', text: 'Export all history (.json)', on: { click: () => state.saved.length ? download('stacksettle_history.json', JSON.stringify(state.saved, null, 2), 'application/json') : toast('No saved sessions yet', 'error') } }),
    h('button', { class: 'row action destructive', text: 'Clear history', on: { click: () => state.saved.length ? confirmSheet({
      title: 'Clear all history?', message: `${state.saved.length} saved sessions will be deleted. Export first if you want a copy.`,
      confirmLabel: 'Clear history', destructive: true, onConfirm: () => { clearHistory(); toast('History cleared'); } }) : toast('History is already empty') } })),
    file);

  view.append(h('div', { class: 'foot' }, 'StackSettle Pro 2.0 · works offline once installed. Add to Home Screen from your browser’s share menu.'));
  return view;
}

function confirmNew(go: () => void) {
  const s = state.session;
  if (s.isDemo || s.players.length === 0) { go(); return; }
  confirmSheet({
    title: 'Replace the current table?',
    message: 'The current table will be replaced. Save it to History first if you need it.',
    confirmLabel: 'Load demo', destructive: true, onConfirm: go
  });
}

// ---------------------------------------------------------------- shell

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'table', label: 'Table', icon: '♠' },
  { id: 'settle', label: 'Settle', icon: '♦' },
  { id: 'history', label: 'History', icon: '♣' },
  { id: 'settings', label: 'Settings', icon: '♥' }
];
const TITLES: Record<Tab, string> = { table: 'Table', settle: 'Settlement', history: 'History', settings: 'Settings' };

let lastTab: Tab | null = null;

function render() {
  document.documentElement.dataset.theme = state.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[state.theme]);

  const app = document.getElementById('app')!;
  const prev = app.querySelector('.scroll');
  const scrollTop = prev && lastTab === state.tab ? prev.scrollTop : 0;
  animateSettle = state.tab === 'settle' && lastTab !== 'settle';
  lastTab = state.tab;

  const views: Record<Tab, () => HTMLElement> = { table: tableView, settle: settleView, history: historyView, settings: settingsView };
  const settleBadge = audit().transfers.filter(t => !state.session.paid[paidKey(t.id, t.amountCents)]).length;

  const scroll = h('main', { class: 'scroll' },
    h('div', { class: 'large-title' },
      h('h1', { text: TITLES[state.tab] }),
      state.tab === 'table'
        ? h('div', { class: 'title-actions' },
            h('span', { class: `pill ${state.session.isDemo ? 'gold' : state.session.isEnded ? 'amber' : 'green'}`, text: state.session.isDemo ? 'Demo' : state.session.isEnded ? 'Settled' : 'Live' }),
            h('button', { class: 'new-btn', text: '＋ New', attrs: { 'aria-label': 'Start a new session' }, on: { click: requestNew } }))
        : null),
    state.tab === 'table' || state.tab === 'settle' ? h('div', { class: 'subtitle', text: state.session.name }) : null,
    views[state.tab]());

  const bar = h('nav', { class: 'tabbar', attrs: { 'aria-label': 'Main' } },
    ...TABS.map(t => h('button', {
      class: `tab ${state.tab === t.id ? 'on' : ''}`,
      attrs: { 'aria-current': state.tab === t.id ? 'page' : undefined },
      on: { click: () => setTab(t.id) }
    },
      h('span', { class: 'tab-icon', text: t.icon }),
      t.id === 'settle' && settleBadge ? h('span', { class: 'badge', text: String(settleBadge) }) : null,
      h('span', { class: 'tab-label', text: t.label }))));

  app.replaceChildren(scroll, bar);
  scroll.scrollTop = scrollTop;
}

subscribe(render);
render();

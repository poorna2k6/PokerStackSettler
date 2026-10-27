import { h, haptic, openSheet, confirmSheet, setFocusFallback, toast } from './dom';
import { clink, setSoundEnabled } from './sound';
import { avatar, chipStack, group, header, kpi } from './ui';
import { formatCode, normalizeCode } from './shared';
import { shareUrl, startSharing, stopSharing, sync } from './sync';
import {
  buildReceipt, formatBuyInCount, formatUnit, parseBackup, MAX_UNIT, MIN_UNIT, type Audit, formatCurrency, leaderboard, toCents, unitCentsFor,
  type SavedSession
} from './engine';
import { PRESETS } from './presets';
import { THEMES, type Theme } from './storage';
import {
  addPlayer, applyReconcile, audit, clearHistory, deleteSaved, endSession, importBackup, loadSaved,
  newSession, paidKey, rebuy, removePlayer, reopenSession, saveToHistory, sessionText, setExpense,
  setName, setPrefs, setTab, setTheme, setUnit, state, subscribe, togglePaid, updatePlayer, type Tab
} from './state';

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

function field(label: string, input: HTMLInputElement) {
  return h('label', { class: 'row field' }, h('span', { text: label }), input);
}

function textInput(value: string, onChange: (v: string) => void, opts: { disabled?: boolean; mode?: string; placeholder?: string; label?: string; fk?: string } = {}) {
  const el = h('input', {
    attrs: {
      type: 'text', inputmode: opts.mode, value, placeholder: opts.placeholder, disabled: opts.disabled,
      'aria-label': opts.label, 'data-fk': opts.fk, autocomplete: 'off', autocapitalize: opts.mode ? 'off' : 'words', enterkeyhint: 'done'
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

const LINK_NOTE = '\n\nThis also stops your live view-only link.';

function requestNew() {
  const s = state.session;
  if ((s.isDemo || s.players.length === 0) && !s.share) { startFresh(); return; }
  confirmSheet({
    title: 'Start a new session?',
    message: s.isEnded
      ? `The current settled session stays in History.${s.share ? LINK_NOTE : ''}`
      : `The current table will be replaced. Save it to History first if you need it.${s.share ? LINK_NOTE : ''}`,
    confirmLabel: 'Start new session', destructive: !s.isEnded, onConfirm: startFresh
  });
}

function tableView(): HTMLElement {
  const s = state.session;
  const a = audit();
  const locked = s.isEnded;
  const view = h('div', { class: 'view' });

  if (!state.storageOk) {
    view.append(h('div', { class: 'demo-card warn-top', attrs: { role: 'alert' } },
      h('div', { class: 'grow' }, h('strong', { text: '⚠️ Storage is blocked' }),
        h('div', { class: 'small', text: 'Changes will be lost when you close this page. Use Settings → Export to keep a copy.' }))));
  }

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
      attrs: { role: 'tab', 'aria-selected': state.prefs.view === v, 'data-fk': `seg:${v}` },
      class: state.prefs.view === v ? 'on' : '',
      on: { click: () => setPrefs({ view: v }) }
    })));
  view.append(h('div', { class: 'players-head' }, h('span', { class: 'section-inline', text: `Players · ${formatUnit(s.defaultBuyIn)}/buy-in` }), seg));

  if (s.players.length === 0) {
    view.append(group(h('div', { class: 'row empty' }, h('span', { text: 'No players yet — add the first seat.' }))));
  } else if (state.prefs.view === 'table' && s.players.length <= MAX_SEATS) {
    view.append(seatsView(a, locked));
  } else {
    if (state.prefs.view === 'table') {
      view.append(h('div', { class: 'foot', text: `Table view fits up to ${MAX_SEATS} players — showing the list instead.` }));
    }
    view.append(group(...a.players.map((p, i) => playerRow(i, p.id, p.name, p.buyInCents, p.cashOutCents, p.buyInCount, p.netCents, locked))));
  }
  if (!locked) {
    view.append(h('button', { class: 'btn tinted block', text: '＋ Add player', on: { click: openAddPlayer } }));
  }

  view.append(header('Session'));
  view.append(group(
    field('Name', textInput(s.name, setName, { disabled: locked, label: 'Session name' })),
    field('Buy-in unit ($)', textInput(String(s.defaultBuyIn), changeUnit, { disabled: locked, mode: 'decimal', label: 'Buy-in unit' })),
    field('Rake ($)', textInput(money(s.expenseCents), setExpense, { disabled: locked, mode: 'decimal', label: 'Expense pot' }))
  ));

  view.append(
    h('button', {
      class: 'btn primary block', text: locked ? 'View settlement' : 'End & settle',
      attrs: { disabled: s.players.length < 2 && !locked },
      on: { click: locked ? () => setTab('settle') : requestEnd }
    }),
    ...(s.players.length < 2 && !locked ? [h('div', { class: 'foot', text: 'Add at least 2 players to settle' })] : []),
    ...(s.share ? [h('div', { class: 'foot share-foot', text: shareStatus() })] : []),
    h('div', { class: 'foot' }, storageNote())
  );
  return view;
}

const MAX_SEATS = 12;
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

function shareStatus(): string {
  switch (sync.phase) {
    case 'ok': return `● Live view on · synced ${sync.at}`;
    case 'syncing': return '● Live view on · syncing…';
    case 'offline': return '○ Live view paused (offline) — will catch up when you’re back online';
    default: return '● Live view on';
  }
}

function openShareSheet() {
  openSheet('Share live view', close => {
    const body = h('div', { class: 'sheet-body' });
    let statusEl: HTMLElement | null = null;
    const stop = subscribe(() => {
      if (!body.isConnected) { stop(); return; }
      if (statusEl) statusEl.textContent = shareStatus();
    });

    let draw = () => {
      const share = state.session.share;
      if (!share) {
        const start = h('button', { class: 'btn primary block', text: 'Start sharing', on: { click: async () => {
          start.disabled = true;
          start.textContent = 'Starting…';
          const msg = await startSharing();
          if (msg) toast(msg, 'error');
          draw();
        } } });
        body.replaceChildren(
          h('p', { class: 'muted', text: 'Let everyone at the table watch live: each player’s buy-ins, chips and who pays whom. They get a link to a view-only page — only you can make changes.' }),
          h('p', { class: 'muted small', text: 'Names and amounts are stored on a server and deleted 7 days after your last change. You can stop sharing at any time.' }),
          ...(state.session.isDemo ? [h('p', { class: 'bad small', text: 'This is demo data — start a fresh session to share a real game.' })] : []),
          state.session.isDemo ? Object.assign(start, { disabled: true }) : start,
          h('button', { class: 'btn plain block', text: 'Not now', on: { click: close } }));
        return;
      }
      const url = shareUrl(share.code);
      const link = h('input', { attrs: { type: 'text', readonly: true, value: url, 'aria-label': 'View-only link', spellcheck: false }, on: { focus: () => link.select() } });
      link.value = url;
      statusEl = h('p', { class: 'muted small', text: shareStatus(), attrs: { role: 'status' } });
      body.replaceChildren(
        group(
          h('label', { class: 'row field' }, h('span', { text: 'Link' }), link),
          h('div', { class: 'row' }, h('span', { class: 'muted', text: 'Code' }), h('strong', { class: 'mono grow right code', text: formatCode(share.code) }))),
        h('button', { class: 'btn primary block', text: 'Share link', on: { click: async () => {
          if (navigator.share) { try { await navigator.share({ title: state.session.name, text: 'Watch our poker game live', url }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; } }
          await copyText(url);
        } } }),
        h('div', { class: 'two' },
          h('button', { class: 'btn tinted', text: 'Copy link', on: { click: () => copyText(url) } }),
          h('button', { class: 'btn tinted', text: 'Copy code', on: { click: () => copyText(formatCode(share.code)) } })),
        statusEl,
        h('p', { class: 'muted small', text: 'Viewers can’t edit anything. The link stays valid for 7 days after your last change, or until you stop sharing.' }),
        h('button', { class: 'btn danger block', text: 'Stop sharing', on: { click: () => { close(); confirmSheet({
          title: 'Stop sharing?', message: 'The link and code stop working immediately for everyone watching.',
          confirmLabel: 'Stop sharing', destructive: true,
          onConfirm: async () => { const ok = await stopSharing(); toast(ok ? 'Sharing stopped' : 'Sharing stopped here — the link will expire on its own', ok ? 'ok' : 'error'); }
        }); } } }));
    };
    const redraw = draw;
    draw = () => { redraw(); (body.querySelector('input, button.primary') as HTMLElement | null)?.focus(); };
    draw();
    return body;
  });
}

function openJoinSheet() {
  openSheet('Join a live game', close => {
    const input = h('input', { attrs: { type: 'text', placeholder: 'Code or link', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, 'aria-label': 'Live game code or link', enterkeyhint: 'go' } });
    const go = () => {
      const raw = input.value.trim();
      const fromLink = /#\/v\/([A-Za-z0-9-]+)/.exec(raw)?.[1];
      const code = normalizeCode(fromLink ?? raw);
      if (!code) { toast('That doesn’t look like a live-game code', 'error'); input.focus(); return; }
      close();
      location.hash = `#/v/${code}`;
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    requestAnimationFrame(() => input.focus());
    return h('div', { class: 'sheet-body' },
      h('p', { class: 'muted', text: 'Enter the code the host gave you (or paste their link) to watch the table. You’ll see it read-only.' }),
      group(h('label', { class: 'row field' }, h('span', { text: 'Code' }), input)),
      h('button', { class: 'btn primary block', text: 'Watch live', on: { click: go } }),
      h('button', { class: 'btn plain block', text: 'Cancel', on: { click: close } }));
  });
}

function storageNote() {
  return state.storageOk
    ? `✓ Auto-saved on this device${state.lastSave ? ' · ' + state.lastSave : ''}`
    : '⚠️ Storage is blocked — changes will be lost when you close this page. Use Export to keep a copy.';
}

function stepper(id: string, buyIn: number, count: number, locked: boolean, after?: () => void) {
  const unit = unitCentsFor(state.session.defaultBuyIn);
  const bump = (d: number) => () => { haptic(); clink(); rebuy(id, d); after?.(); };
  const who = state.session.players.find(p => p.id === id)?.name ?? 'player';
  return h('div', { class: 'stepper' },
    h('button', { text: '−', attrs: { 'aria-label': `Remove one buy-in for ${who}`, 'data-fk': `minus:${id}`, disabled: locked || buyIn < unit }, on: { click: bump(-1) } }),
    h('span', { class: `mono step-label ${`${formatBuyInCount(count)}${formatCurrency(buyIn)}`.length > 9 ? 'stack' : ''}` }, h('b', { text: formatBuyInCount(count) }), h('i', { class: 'sep', text: ' · ' }), h('em', { text: formatCurrency(buyIn) })),
    h('button', { text: '+', attrs: { 'aria-label': `Add one buy-in for ${who}`, 'data-fk': `plus:${id}`, disabled: locked }, on: { click: bump(1) } }));
}

function confirmRemove(id: string, name: string, after?: () => void) {
  confirmSheet({
    title: `Remove ${name}?`, message: 'Their buy-ins and chips will be deleted from this session.',
    confirmLabel: 'Remove', destructive: true, onConfirm: () => { removePlayer(id); after?.(); }
  });
}

/** Names are never edited inline: the user must confirm, then type the new name in a dedicated sheet. */
function requestRename(id: string) {
  const p = state.session.players.find(x => x.id === id);
  if (!p || state.session.isEnded) return;
  confirmSheet({
    title: `Rename ${p.name}?`,
    message: 'Are you sure you want to change this player’s name? Their buy-ins and chips stay the same.',
    confirmLabel: 'Yes, rename',
    onConfirm: () => openRenameSheet(id)
  });
}

function openRenameSheet(id: string) {
  const p = state.session.players.find(x => x.id === id);
  if (!p) return;
  openSheet('Rename player', close => {
    const input = h('input', { attrs: { type: 'text', value: p.name, maxlength: 40, autocomplete: 'off', autocapitalize: 'words', 'aria-label': 'New name', enterkeyhint: 'done' } });
    input.value = p.name;
    const save = () => {
      const next = input.value.trim();
      if (!next) { toast('Name can’t be empty', 'error'); input.focus(); return; }
      if (next !== p.name) updatePlayer(id, { name: next.slice(0, 40) });
      close();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return h('div', { class: 'sheet-body' },
      group(h('label', { class: 'row field' }, h('span', { text: 'Name' }), input)),
      h('button', { class: 'btn primary block', text: 'Save name', on: { click: save } }),
      h('button', { class: 'btn plain block', text: 'Cancel', on: { click: close } }));
  });
}

function playerRow(i: number, id: string, name: string, buyIn: number, cashOut: number, count: number, net: number, locked: boolean) {
  const cash = textInput(money(cashOut), v => updatePlayer(id, { cashOutCents: Math.max(0, toCents(v)) }), { disabled: locked, mode: 'decimal', label: `${name} ending chips`, fk: `cash:${id}` });
  cash.classList.add('mono');
  const tone = net > 0 ? 'good' : net < 0 ? 'bad' : 'muted';
  return h('div', { class: 'row player' },
    h('div', { class: `player-top ${name.length > 14 ? 'wrapname' : ''}` },
      avatar(i, name),
      h('div', { class: 'player-name' },
        h('span', { class: 'player-name-text', text: name }),
        locked ? null : h('button', { class: 'icon-btn small', text: '✎', attrs: { 'aria-label': `Rename ${name}` }, on: { click: () => requestRename(id) } })),
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
      const cash = textInput(money(p.cashOutCents), v => { updatePlayer(id, { cashOutCents: Math.max(0, toCents(v)) }); draw(); }, { disabled: locked, mode: 'decimal', label: 'Ending chips' });
      cash.classList.add('mono');
      body.replaceChildren(
        group(
          h('div', { class: 'row' }, h('span', { class: 'muted', text: 'Name' }), h('strong', { class: 'grow right', text: p.name }),
            locked ? null : h('button', { class: 'link', text: 'Rename', attrs: { 'aria-label': `Rename ${p.name}` }, on: { click: () => { close(); requestRename(id); } } })),
          field('Ending chips ($)', cash)),
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
      ? textInput(String(state.session.defaultBuyIn), v => { changeUnit(v); countLabel.textContent = `Buy-ins (× ${formatUnit(state.session.defaultBuyIn)})`; }, { mode: 'decimal', label: 'Buy-in unit for this session' })
      : null;
    const submit = (keepOpen: boolean) => {
      const n = parseFloat(count.value);
      addPlayer(name.value, Number.isFinite(n) ? n : 1);
      haptic();
      if (keepOpen) { name.value = ''; count.value = '1'; name.focus(); } else close();
    };
    name.addEventListener('keydown', e => { if (e.key === 'Enter') submit(true); });
    requestAnimationFrame(() => name.focus());
    return h('div', { class: 'sheet-body' },
      group(...(unit ? [field('Buy-in unit ($)', unit)] : []), field('Name', name), h('label', { class: 'row field' }, countLabel, count)),
      h('button', { class: 'btn primary block', text: 'Add & finish', on: { click: () => submit(false) } }),
      h('button', { class: 'btn tinted block', text: 'Add & next player', on: { click: () => submit(true) } }));
  });
}

function finishSession() {
  if (endSession()) { setTab('settle'); toast('Session settled'); }
  else {
    const a = audit();
    toast(a.expenseCents > a.totalBuyInCents
      ? 'Rake/expense is larger than all buy-ins — lower it to settle'
      : 'Can’t balance this table — check the chips and rake', 'error');
  }
}

function requestEnd() {
  const a = audit();
  if (a.players.length < 2) { toast('Add at least 2 players to settle', 'error'); return; }
  if (!a.isBalanced) {
    confirmSheet({
      title: `Chips are ${formatCurrency(Math.abs(a.discrepancyCents))} ${a.discrepancyCents < 0 ? 'short' : 'over'}`,
      message: `${a.totalPlayerCashOutCents === 0 ? 'No ending chips have been entered yet.\n\n' : ''}Ending chips (${formatCurrency(a.totalAccountedCents)}) don't match buy-ins (${formatCurrency(a.totalBuyInCents)}).\n\nContinuing will adjust payouts so the table balances (pro-rata among winners, or equally if nobody is ahead), then lock the session.`,
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
        attrs: { role: 'checkbox', 'data-fk': `transfer:${key}`, 'aria-checked': paid, 'aria-label': `${t.fromName} pays ${t.toName} ${formatCurrency(t.amountCents)}` },
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
      h('button', { class: 'btn tinted', text: 'Save to history', on: { click: () => { if (saveToHistory(s.isEnded ? 'Completed & Settled' : 'Saved Snapshot')) toast('Saved to History'); else toast('Demo data isn’t saved — start fresh', 'error'); } } }),
      h('button', { class: 'btn tinted', text: 'Download .txt', on: { click: () => download(`${safeFile(s.name)}_settlement.txt`, sessionText(s)) } })),
    ...(s.isEnded ? [] : [h('button', { class: 'btn plain block', text: 'End & settle…', attrs: { disabled: a.players.length < 2 }, on: { click: requestEnd } })])
  );
  return view;
}

function historyView(): HTMLElement {
  const view = h('div', { class: 'view' });
  const rows = leaderboard(state.saved);

  view.append(header('Lifetime leaderboard', rows.length ? `${state.saved.length} session${state.saved.length === 1 ? '' : 's'}` : ''));
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
    h('button', { class: 'btn primary block', text: 'Open on Table', on: { click: () => {
      close();
      if (!state.session.share) { loadSaved(s.id); return; }
      confirmSheet({
        title: 'Replace the current table?',
        message: `The table you have open will be replaced.${LINK_NOTE}`,
        confirmLabel: 'Open and stop link', destructive: true, onConfirm: () => loadSaved(s.id)
      });
    } } }),
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
    attrs: { 'aria-pressed': state.theme === t, 'aria-label': `${t} theme`, 'data-fk': `theme:${t}` },
    on: { click: () => setTheme(t) }
  }, h('span', { class: 'dot', attrs: { style: `background:${swatch[t]}` } }), h('span', { text: t[0].toUpperCase() + t.slice(1) })))));

  view.append(header('Sound & feel'));
  view.append(group(h('button', {
    class: 'row action', attrs: { role: 'switch', 'aria-checked': state.prefs.sound },
    on: { click: () => { const on = !state.prefs.sound; setSoundEnabled(on); setPrefs({ sound: on }); clink(); } }
  }, h('span', { class: 'grow', text: 'Chip sounds' }), h('span', { class: `switch ${state.prefs.sound ? 'on' : ''}` }, h('i')))));

  view.append(header('Live games'));
  view.append(group(
    h('button', { class: 'row action', on: { click: openJoinSheet } }, h('span', { class: 'grow', text: 'Join a live game' }), h('span', { class: 'muted', text: 'code or link ›' })),
    ...(state.session.isDemo ? [] : [h('button', { class: 'row action', on: { click: openShareSheet } }, h('span', { class: 'grow', text: state.session.share ? 'Manage live sharing' : 'Share this table live' }), h('span', { class: 'muted', text: state.session.share ? '● on ›' : '›' }))])));

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
      const text = String(reader.result ?? '');
      const apply = () => {
        const msg = importBackup(text);
        toast(msg ?? 'That file is not a StackSettle backup', msg ? 'ok' : 'error');
      };
      const parsed = parseBackup(text);
      if (parsed?.kind === 'session' && ((!state.session.isDemo && state.session.players.length > 0) || state.session.share)) {
        confirmSheet({
          title: 'Replace the current table?',
          message: `Restoring “${parsed.session.name}” will replace the table you have open. Save it to History first if you need it.${state.session.share ? LINK_NOTE : ''}`,
          confirmLabel: 'Restore', destructive: true, onConfirm: apply
        });
      } else apply();
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
  if ((s.isDemo || s.players.length === 0) && !s.share) { go(); return; }
  confirmSheet({
    title: 'Replace the current table?',
    message: `The current table will be replaced. Save it to History first if you need it.${s.share ? LINK_NOTE : ''}`,
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
  const settleBadge = !audit().isBalanced ? 0 : audit().transfers.filter(t => !state.session.paid[paidKey(t.id, t.amountCents)]).length;

  const scroll = h('main', { class: 'scroll' },
    h('div', { class: 'large-title' },
      h('h1', { text: TITLES[state.tab] }),
      state.tab === 'table'
        ? h('div', { class: `title-actions ${state.session.share ? 'sharing' : ''}` },
            h('span', { class: `pill ${state.session.isDemo ? 'gold' : state.session.isEnded ? 'amber' : 'green'}`, text: state.session.isDemo ? 'Demo' : state.session.isEnded ? 'Settled' : 'Live' }),
            ...(state.session.isDemo ? [] : [h('button', { class: `new-btn ghost ${state.session.share ? 'on' : ''}`, text: state.session.share ? '● Sharing' : 'Share', attrs: { 'aria-label': state.session.share ? 'Live view is on — manage sharing' : 'Share a view-only live link' }, on: { click: openShareSheet } })]),
            h('button', { class: 'new-btn', text: '＋ New', attrs: { 'aria-label': 'Start a new session' }, on: { click: requestNew } }))
        : null),
    state.tab === 'table' || state.tab === 'settle' ? h('div', { class: 'subtitle', text: state.session.name }) : null,
    views[state.tab]());

  const bar = h('nav', { class: 'tabbar', attrs: { 'aria-label': 'Main' } },
    ...TABS.map(t => h('button', {
      class: `tab ${state.tab === t.id ? 'on' : ''}`,
      attrs: { 'aria-current': state.tab === t.id ? 'page' : undefined, 'data-fk': `tab:${t.id}`, 'aria-label': t.id === 'settle' && settleBadge ? `${t.label}, ${settleBadge} unpaid` : t.label },
      on: { click: () => setTab(t.id) }
    },
      h('span', { class: 'tab-icon', text: t.icon, attrs: { 'aria-hidden': 'true' } }),
      t.id === 'settle' && settleBadge ? h('span', { class: 'badge', text: String(settleBadge), attrs: { 'aria-hidden': 'true' } }) : null,
      h('span', { class: 'tab-label', text: t.label }))));

  app.replaceChildren(scroll, bar);
  scroll.scrollTop = scrollTop;
}

// ---------------------------------------------------------------- focus continuity
// render() rebuilds the whole screen, which would drop keyboard focus to <body>. We remember the
// last focused control (by a stable key) and put focus back, or on the next control after Tab.

const fkOf = (el: Element) =>
  (el as HTMLElement).dataset?.fk ?? `${el.tagName}|${el.getAttribute('aria-label') ?? ''}|${(el.textContent ?? '').trim().slice(0, 40)}`;
let lastFocus: string | null = null;
let lastIndex = 0;
let lastTabId: Tab | null = null;

const focusables = () =>
  [...document.getElementById('app')!.querySelectorAll<HTMLElement>('button, input')].filter(
    el => !(el as HTMLButtonElement).disabled && !(el as HTMLInputElement).hidden && el.offsetParent !== null
  );

document.addEventListener('focusin', e => {
  const t = e.target;
  if (t instanceof HTMLElement && t !== document.body && !t.closest('#sheets')) {
    lastFocus = fkOf(t);
    lastIndex = Math.max(0, focusables().indexOf(t));
  }
});

function restoreFocus() {
  if (!lastFocus || document.querySelector('#sheets .sheet')) return;
  const app = document.getElementById('app')!;
  const active = document.activeElement;
  if (active && active !== document.body && app.contains(active)) { lastTabId = state.tab; return; }
  const items = focusables();
  if (items.length === 0) return;
  const tabChanged = lastTabId !== null && lastTabId !== state.tab;
  lastTabId = state.tab;
  let i = tabChanged ? -1 : items.findIndex(el => fkOf(el) === lastFocus);
  if (i < 0 && !tabChanged && lastFocus.startsWith('minus:')) {
    i = items.findIndex(el => el.dataset.fk === `plus:${lastFocus!.slice(6)}`); // "−" became disabled: use its "+"
  }
  if (tabChanged) {
    i = items.findIndex(el => el.dataset.fk === `tab:${state.tab}`);
  }
  if (i < 0) i = Math.min(lastIndex, items.length - 1); // control vanished: stay at the same position
  items[i].focus({ preventScroll: true });
}
setFocusFallback(restoreFocus);

const renderAndKeepFocus = () => { render(); restoreFocus(); requestAnimationFrame(restoreFocus); };

// An input commits on blur, i.e. on the mousedown of whatever was tapped next. Re-rendering at that moment
// would replace the tapped control before mouseup (swallowing the tap) and bounce focus back. So while a
// pointer is down we only note that a render is due, and perform it right after the pointer is released.
let pointerActive = false;
let renderPending = false;
let pointerTimer: number | undefined;
const flushRender = () => {
  clearTimeout(pointerTimer);
  pointerActive = false;
  if (renderPending && !isTyping()) { renderPending = false; renderAndKeepFocus(); }
};
// Never replace a field the user is in the middle of typing in: that would drop the uncommitted text.
const isTyping = () => {
  const a = document.activeElement;
  return a instanceof HTMLInputElement && document.getElementById('app')!.contains(a) && a.value !== a.defaultValue;
};
// Keyboard blur (Tab) flushes right away; a blur caused by a press waits for the release instead.
// A text field commits on 'change', which can fire while focus is moving to another field (Tab, voice control,
// autofill...). Rendering synchronously there would replace the field that is about to receive input, so
// renders caused by a commit run one task later, when the newly focused field already holds its value.
let committing = false;
document.addEventListener('change', () => { committing = true; window.setTimeout(() => { committing = false; }, 0); }, true);
document.addEventListener('focusout', () => { window.setTimeout(() => { if (!pointerActive) flushRender(); }, 0); });
const pressStart = (e: Event) => {
  // Tapping empty space blurs the field on purpose; don't pull focus back to it afterwards.
  if (e.type === 'pointerdown' && !(e.target instanceof Element && e.target.closest('button, input, [role="checkbox"]'))) lastFocus = null;
  pointerActive = true;
  clearTimeout(pointerTimer);
  pointerTimer = window.setTimeout(flushRender, 1500); // safety net if the release is never seen
};
// Touch taps fire pointerup first and the compatibility mouse events (where focus and blur happen) a moment
// later, so after a touch release we keep deferring until the click arrives (or a short timeout).
const pressEnd = (e: Event) => {
  clearTimeout(pointerTimer);
  const touch = e.type.startsWith('touch') || (e instanceof PointerEvent && e.pointerType === 'touch');
  pointerTimer = window.setTimeout(flushRender, touch ? 400 : 0);
};
for (const type of ['pointerdown', 'mousedown', 'touchstart']) document.addEventListener(type, pressStart, true);
for (const type of ['pointerup', 'pointercancel', 'mouseup', 'touchend', 'touchcancel']) document.addEventListener(type, pressEnd, true);
document.addEventListener('click', () => { window.setTimeout(flushRender, 0); });
subscribe(() => {
  if (committing) { renderPending = true; window.setTimeout(() => { if (!pointerActive) flushRender(); }, 0); return; }
  if (pointerActive || isTyping()) renderPending = true; else renderAndKeepFocus();
});
render();

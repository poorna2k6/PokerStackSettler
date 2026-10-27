// Read-only live view of a shared table. It never loads or writes the device's own session, has no
// edit controls, and holds no host key: all it can do is poll GET /api/share.
import { h, openSheet } from './dom';
import { openHandsSheet } from './hands';
import { drawSettlement, sharePicture } from './picture';
import { formatBuyInCount, formatCurrency, formatUnit, paidKey, solve } from './engine';
import { formatCode, normalizeCode, type SharedSnapshot } from './shared';
import { THEMES, loadTheme } from './storage';
import { MAX_SEATS, avatar, chipStack, group, header, kpi, ovalTable } from './ui';

const POLL_MS = 3000;
const THEME_COLORS: Record<(typeof THEMES)[number], string> = { midnight: '#000000', felt: '#0a3d2a', ocean: '#06182c', light: '#f2f2f7' };

type Phase = 'loading' | 'ok' | 'offline' | 'gone' | 'invalid';

export function mountViewer(rawCode: string) {
  const code = normalizeCode(rawCode);
  const theme = loadTheme();
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
  document.title = 'Live table — StackSettle';

  const app = document.getElementById('app')!;
  let snap: SharedSnapshot | null = null;
  let rev = 0;
  let phase: Phase = code ? 'loading' : 'invalid';
  let updated = '';
  let failures = 0;
  let timer: number | undefined;
  // The shared link opens on the oval table; the viewer can switch to the list. In memory only: a viewer
  // never writes anything to this device.
  let view: 'table' | 'list' = 'table';
  let statusEl: HTMLElement | null = null;

  // "That's me": remembered for this browser tab only (sessionStorage), never in the device's saved data.
  const ME_KEY = `viewer-me:${code ?? ''}`;
  const readMe = (): string | null => { try { return sessionStorage.getItem(ME_KEY); } catch { return null; } };
  const writeMe = (id: string | null) => { try { if (id) sessionStorage.setItem(ME_KEY, id); else sessionStorage.removeItem(ME_KEY); } catch { /* ignore */ } };
  let meId: string | null = readMe();

  const leave = () => { history.replaceState(null, '', location.pathname); location.reload(); };

  function body(): Node[] {
    if (phase === 'invalid') {
      return [group(h('div', { class: 'row empty', attrs: { role: 'alert' } }, h('span', { text: 'That live-game code isn’t valid. Ask the host for the link again.' })))];
    }
    if (phase === 'gone') {
      return [group(h('div', { class: 'row empty', attrs: { role: 'alert' } }, h('span', { text: 'This live game isn’t available any more — it expired or the host stopped sharing.' })))];
    }
    if (!snap) {
      return [group(h('div', { class: 'row empty' }, h('span', { text: phase === 'offline' ? 'Can’t reach the server — retrying…' : 'Loading the table…' })))];
    }
    const a = solve(snap.players, snap.expenseCents, snap.defaultBuyIn);
    const out: Node[] = [
      h('div', { class: 'demo-card view-only' },
        h('div', { class: 'grow' }, h('strong', { text: '👀 View only' }), h('span', { class: 'small', text: ' — only the host can make changes' })))
    ];
    out.push(h('button', { class: 'btn tinted block slim', text: '🃏 New to poker? How hands rank', on: { click: openHandsSheet } }));
    out.push(h('div', { class: 'kpis' },
      kpi('Players', String(a.players.length)),
      kpi('Pot', formatCurrency(a.totalBuyInCents), `${a.totalBuyInCount} buy-in${a.totalBuyInCount === 1 ? '' : 's'}`),
      kpi('Chips out', formatCurrency(a.totalAccountedCents), a.isBalanced ? 'Balanced ✓' : formatCurrency(a.discrepancyCents, true), a.isBalanced ? 'good' : 'warn')));

    const seg = h('div', { class: 'segmented', attrs: { role: 'tablist', 'aria-label': 'Player view' } },
      ...(['table', 'list'] as const).map(m => h('button', {
        text: m === 'table' ? 'Table' : 'List', class: view === m ? 'on' : '',
        attrs: { role: 'tab', 'aria-selected': view === m },
        on: { click: () => { view = m; render(); } }
      })));
    out.push(meCard(a));
    out.push(h('div', { class: 'players-head' },
      h('span', { class: 'section-inline', text: `Players · ${formatUnit(snap.defaultBuyIn)}/buy-in`, attrs: { role: 'heading', 'aria-level': 2 } }), seg));

    const tooMany = a.players.length > MAX_SEATS;
    if (a.players.length === 0) {
      out.push(group(h('div', { class: 'row empty' }, h('span', { text: 'No players at the table yet.' }))));
    } else if (view === 'table' && !tooMany) {
      out.push(ovalTable({
        a,
        label: p => `${p.name}: ${formatBuyInCount(p.buyInCount)} in, chips ${formatCurrency(p.cashOutCents)}, net ${formatCurrency(p.netCents, true)}. Tap for details.`,
        onSeat: p => openSeatDetails(p, snap!.defaultBuyIn),
        note: p => `${formatBuyInCount(p.buyInCount)} · ${formatCurrency(p.buyInCents)}`,
        hint: 'Tap a seat for details',
        highlightId: meId ?? undefined
      }));
    } else {
      if (view === 'table' && tooMany) out.push(h('div', { class: 'foot', text: `Table view fits up to ${MAX_SEATS} players — showing the list instead.` }));
      out.push(group(...a.players.map((p, i) => h('div', { class: `row player view-row ${p.id === meId ? 'me' : ''}` },
        h('div', { class: 'player-top' },
          avatar(i, p.name),
          h('div', { class: 'player-name' }, h('span', { class: 'player-name-text', text: p.name })),
          chipStack(p.buyInCount),
          h('span', { class: `net mono ${p.netCents > 0 ? 'good' : p.netCents < 0 ? 'bad' : 'muted'}`, text: formatCurrency(p.netCents, true) })),
        h('div', { class: 'view-meta mono' },
          h('span', { text: `In: ${formatBuyInCount(p.buyInCount)} · ${formatCurrency(p.buyInCents)}` }),
          h('span', { text: `Chips: ${formatCurrency(p.cashOutCents)}` }))))));
    }

    if (a.expenseCents > 0) {
      out.push(group(h('div', { class: 'row banner' }, h('span', { class: 'muted', text: 'Rake / expense' }), h('strong', { class: 'mono', text: formatCurrency(a.expenseCents) }))));
    }

    if (a.players.length >= 2 && a.isBalanced) {
      out.push(header(snap.isEnded ? 'Who pays whom' : 'Payments if settled now', a.transfers.length ? `${a.transfers.length} transfer${a.transfers.length === 1 ? '' : 's'}` : ''));
      out.push(a.transfers.length === 0
        ? group(h('div', { class: 'row empty' }, h('span', { text: 'No payments needed 🎉' })))
        : group(...a.transfers.map(t => {
            const paid = Boolean(snap!.paid[paidKey(t.id, t.amountCents)]);
            return h('div', { class: `row transfer ${paid ? 'paid' : ''}` },
              h('span', { class: `check ${paid ? 'on' : ''}`, text: '✓', attrs: { 'aria-hidden': 'true' } }),
              h('span', { class: 'who' }, h('span', { class: 'bad', text: t.fromName }), h('span', { class: 'muted', text: ' pays ' }),
                h('span', { class: t.isHouse ? 'house' : 'good', text: t.toName }),
                paid ? h('span', { class: 'muted small', text: ' (paid)' }) : null),
              h('span', { class: 'mono amt', text: formatCurrency(t.amountCents) }));
          })));
    } else if (a.players.length >= 2) {
      out.push(group(h('div', { class: 'row banner info' }, h('span', { text: 'The host is still entering chips — payments appear once the table balances.' }))));
    }
    if (a.players.length >= 2) {
      out.push(header('Standings'));
      out.push(group(...[...a.players].sort((x, y) => y.netCents - x.netCents).map((p, i) =>
        h('div', { class: `row standing ${i === 0 && p.netCents > 0 ? 'gold' : ''} ${p.id === meId ? 'me' : ''}` },
          h('span', { class: 'rank', text: i === 0 && p.netCents > 0 ? '🏆' : String(i + 1) }),
          h('span', { class: 'grow', text: p.name }),
          h('span', { class: 'muted mono', text: formatBuyInCount(p.buyInCount) }),
          h('span', { class: `mono ${p.netCents > 0 ? 'good' : p.netCents < 0 ? 'bad' : 'muted'}`, text: formatCurrency(p.netCents, true) })))));
    }
    if (a.players.length >= 2 && a.isBalanced) {
      out.push(h('button', { class: 'btn tinted block', text: '🖼️ Save as picture', on: { click: () => sharePicture(drawSettlement(snap!.name, a, k => Boolean(snap!.paid[k])), 'settlement.png', snap!.name) } }));
    }
    return out;
  }

  function meCard(a: ReturnType<typeof solve>): Node {
    const me = a.players.find(p => p.id === meId);
    if (!me) {
      return h('button', { class: 'btn tinted block slim', text: '👤 That’s me — pick your name', on: { click: pickMe } });
    }
    const lines: Node[] = [];
    if (a.players.length >= 2 && a.isBalanced) {
      for (const t of a.transfers) {
        const paid = Boolean(snap!.paid[paidKey(t.id, t.amountCents)]);
        if (t.fromId === me.id) lines.push(h('div', { class: 'me-line' }, h('span', { class: 'bad', text: `You pay ${t.toName}` }), h('strong', { class: 'mono', text: `${formatCurrency(t.amountCents)}${paid ? ' ✓' : ''}` })));
        else if (t.toId === me.id) lines.push(h('div', { class: 'me-line' }, h('span', { class: 'good', text: `${t.fromName} pays you` }), h('strong', { class: 'mono', text: `${formatCurrency(t.amountCents)}${paid ? ' ✓' : ''}` })));
      }
      if (lines.length === 0) lines.push(h('div', { class: 'me-line muted', text: 'You don’t owe or receive anything.' }));
    } else {
      lines.push(h('div', { class: 'me-line muted', text: 'Your payments appear here once the table balances.' }));
    }
    return h('div', { class: 'me-card' },
      h('div', { class: 'me-head' },
        h('strong', { text: `You: ${me.name}` }),
        h('span', { class: `mono ${me.netCents > 0 ? 'good' : me.netCents < 0 ? 'bad' : 'muted'}`, text: formatCurrency(me.netCents, true) }),
        h('button', { class: 'link', text: 'Not you?', on: { click: pickMe } })),
      ...lines);
  }

  function pickMe() {
    if (!snap) return;
    const players = snap.players;
    openSheet('Which player are you?', close => h('div', { class: 'sheet-body' },
      h('p', { class: 'muted small', text: 'We’ll highlight your seat and show what you pay or receive. Only saved in this browser tab.' }),
      group(...players.map(p => h('button', { class: 'row action', on: { click: () => { writeMe(p.id); meId = p.id; close(); render(); } } },
        h('span', { class: 'grow', text: p.name })))),
      ...(meId ? [h('button', { class: 'btn plain block', text: 'Clear', on: { click: () => { writeMe(null); meId = null; close(); render(); } } })] : []),
      h('button', { class: 'btn plain block', text: 'Cancel', on: { click: close } })));
  }

  function openSeatDetails(p: { name: string; buyInCount: number; buyInCents: number; cashOutCents: number; netCents: number }, unit: number) {
    openSheet(p.name, close => h('div', { class: 'sheet-body' },
      group(
        h('div', { class: 'row' }, h('span', { class: 'muted', text: 'Buy-ins' }), h('strong', { class: 'mono grow right', text: `${formatBuyInCount(p.buyInCount)} (${formatUnit(unit)} each)` })),
        h('div', { class: 'row' }, h('span', { class: 'muted', text: 'Total in' }), h('strong', { class: 'mono grow right', text: formatCurrency(p.buyInCents) })),
        h('div', { class: 'row' }, h('span', { class: 'muted', text: 'Chips' }), h('strong', { class: 'mono grow right', text: formatCurrency(p.cashOutCents) })),
        h('div', { class: 'row' }, h('span', { class: 'muted', text: 'Net' }),
          h('strong', { class: `mono grow right ${p.netCents > 0 ? 'good' : p.netCents < 0 ? 'bad' : 'muted'}`, text: formatCurrency(p.netCents, true) }))),
      h('p', { class: 'muted small', text: 'View only — the host updates these numbers.' }),
      h('button', { class: 'btn primary block', text: 'Close', on: { click: close } })));
  }

  const statusText = () =>
    phase === 'invalid' ? 'Invalid code' :
    phase === 'ok' ? `● Live · updated ${updated}` :
    phase === 'offline' ? '○ Reconnecting…' :
    phase === 'gone' ? 'Stopped' : '';

  function render() {
    const pill = !snap ? null : h('span', { class: `pill ${snap.isEnded ? 'amber' : 'green'}`, text: snap.isEnded ? 'Settled' : 'Live' });
    app.replaceChildren(
      h('main', { class: 'scroll' },
        h('div', { class: 'large-title' }, h('h1', { text: 'Live table' }), pill),
        h('div', { class: 'subtitle wrap', text: snap?.name ?? (code ? `Code ${formatCode(code)}` : '') }),
        h('div', { class: 'view' }, ...body())),
      h('nav', { class: 'tabbar viewer-bar', attrs: { 'aria-label': 'Live view' } },
        (statusEl = h('span', { class: `viewer-status ${phase}`, text: statusText(), attrs: { role: 'status', 'aria-live': 'polite' } })),
        h('button', { class: 'link', text: 'Leave', attrs: { 'aria-label': 'Leave live view' }, on: { click: leave } })));
  }

  async function poll() {
    clearTimeout(timer);
    if (!code || phase === 'gone') return;
    let next = POLL_MS;
    try {
      const res = await fetch(`/api/share?code=${code}${rev ? `&since=${rev}` : ''}`, { cache: 'no-store' });
      if (res.status === 404) { phase = 'gone'; render(); return; }
      if (res.status === 429) { throw new Error('rate'); }
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { unchanged?: boolean; rev: number; snapshot?: SharedSnapshot };
      failures = 0;
      const changed = (!data.unchanged && !!data.snapshot) || phase !== 'ok';
      if (!data.unchanged && data.snapshot) { snap = data.snapshot; rev = data.rev; }
      phase = 'ok';
      updated = new Date().toTimeString().slice(0, 8);
      // Only rebuild the page when something changed, so keyboard focus and open sheets are not disturbed.
      if (changed) render();
      else if (statusEl) { statusEl.textContent = statusText(); statusEl.className = `viewer-status ${phase}`; }
    } catch (e) {
      failures += 1;
      phase = 'offline';
      next = Math.min(30000, POLL_MS * 2 ** Math.min(failures, 4)) * ((e as Error).message === 'rate' ? 3 : 1);
      render();
    }
    if (document.visibilityState === 'visible') timer = window.setTimeout(poll, next);
  }

  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (document.visibilityState === 'visible') void poll();
  });
  window.addEventListener('online', () => { failures = 0; void poll(); });

  render();
  if (code) void poll();
}

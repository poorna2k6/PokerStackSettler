// Read-only live view of a shared table. It never loads or writes the device's own session, has no
// edit controls, and holds no host key: all it can do is poll GET /api/share.
import { h } from './dom';
import { formatBuyInCount, formatCurrency, formatUnit, paidKey, solve } from './engine';
import { formatCode, normalizeCode, type SharedSnapshot } from './shared';
import { THEMES, loadTheme } from './storage';
import { avatar, chipStack, group, header, kpi } from './ui';

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

  const leave = () => { history.replaceState(null, '', location.pathname); location.reload(); };

  function body(): Node[] {
    if (phase === 'invalid') {
      return [group(h('div', { class: 'row empty' }, h('span', { text: 'That live-game code isn’t valid. Ask the host for the link again.' })))];
    }
    if (phase === 'gone') {
      return [group(h('div', { class: 'row empty' }, h('span', { text: 'This live game isn’t available any more — it expired or the host stopped sharing.' })))];
    }
    if (!snap) {
      return [group(h('div', { class: 'row empty' }, h('span', { text: phase === 'offline' ? 'Can’t reach the server — retrying…' : 'Loading the table…' })))];
    }
    const a = solve(snap.players, snap.expenseCents, snap.defaultBuyIn);
    const out: Node[] = [
      h('div', { class: 'demo-card view-only' },
        h('div', { class: 'grow' }, h('strong', { text: '👀 View only' }),
          h('div', { class: 'small', text: 'You’re watching live. Only the host can make changes.' })))
    ];
    out.push(h('div', { class: 'kpis' },
      kpi('Players', String(a.players.length)),
      kpi('Pot', formatCurrency(a.totalBuyInCents), `${a.totalBuyInCount} buy-in${a.totalBuyInCount === 1 ? '' : 's'}`),
      kpi('Chips out', formatCurrency(a.totalAccountedCents), a.isBalanced ? 'Balanced ✓' : formatCurrency(a.discrepancyCents, true), a.isBalanced ? 'good' : 'warn')));

    out.push(header('Players', `${formatUnit(snap.defaultBuyIn)}/buy-in`));
    out.push(a.players.length === 0
      ? group(h('div', { class: 'row empty' }, h('span', { text: 'No players at the table yet.' })))
      : group(...a.players.map((p, i) => h('div', { class: 'row player view-row' },
          h('div', { class: 'player-top' },
            avatar(i, p.name),
            h('div', { class: 'player-name' }, h('span', { class: 'player-name-text', text: p.name })),
            chipStack(p.buyInCount),
            h('span', { class: `net mono ${p.netCents > 0 ? 'good' : p.netCents < 0 ? 'bad' : 'muted'}`, text: formatCurrency(p.netCents, true) })),
          h('div', { class: 'view-meta mono' },
            h('span', { text: `In: ${formatBuyInCount(p.buyInCount)} · ${formatCurrency(p.buyInCents)}` }),
            h('span', { text: `Chips: ${formatCurrency(p.cashOutCents)}` }))))));

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
    return out;
  }

  function render() {
    const status =
      phase === 'ok' ? `● Live · updated ${updated}` :
      phase === 'offline' ? '○ Reconnecting…' :
      phase === 'gone' ? 'Stopped' : '';
    const pill = !snap ? null : h('span', { class: `pill ${snap.isEnded ? 'amber' : 'green'}`, text: snap.isEnded ? 'Settled' : 'Live' });
    app.replaceChildren(
      h('main', { class: 'scroll' },
        h('div', { class: 'large-title' }, h('h1', { text: 'Live table' }), pill),
        h('div', { class: 'subtitle', text: snap?.name ?? (code ? `Code ${formatCode(code)}` : '') }),
        h('div', { class: 'view' }, ...body())),
      h('nav', { class: 'tabbar viewer-bar', attrs: { 'aria-label': 'Live view' } },
        h('span', { class: 'viewer-status', text: status, attrs: { role: 'status', 'aria-live': 'polite' } }),
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
      if (!data.unchanged && data.snapshot) { snap = data.snapshot; rev = data.rev; }
      phase = 'ok';
      updated = new Date().toTimeString().slice(0, 8);
      render();
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

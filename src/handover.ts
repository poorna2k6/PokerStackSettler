// Handing the host role to someone else (host side) and taking it over (new host side).
//
// Two ways, both ending with the server swapping the stored host-key hash for one the NEW host made:
//  - a player in the list: they Accept on their viewer page, then THIS phone asks the host to confirm;
//  - a one-time QR/link for anyone (including people not in the list): scanning it and accepting is enough,
//    because holding the code means being next to the host's screen.
import { confirmSheet, h, openSheet, toast } from './dom';
import { makeHostKey } from './keys';
import { normalizeCode, type PublicOffer, type SharedSnapshot } from './shared';
import { adoptSharedSession, state } from './state';
import { call, handedOver } from './sync';
import { renderQr } from './qr';
import { group } from './ui';

const POLL_MS = 2500;

interface Pending {
  kind: 'seat' | 'link';
  playerId?: string;
  name?: string;
  url?: string;
  expiresAt: number;
  status: 'open' | 'claimed';
}

let pending: Pending | null = null;
let watcher: number | undefined;
const listeners = new Set<() => void>();

function setPending(p: Pending | null) {
  pending = p;
  listeners.forEach(fn => fn());
  if (pending && watcher === undefined) watcher = window.setInterval(() => void tick(), POLL_MS);
  if (!pending && watcher !== undefined) { clearInterval(watcher); watcher = undefined; }
}

const myShare = () => state.session.share;

async function withdraw() {
  const share = myShare();
  setPending(null);
  if (share) { try { await call('DELETE', `?code=${share.code}&action=offer`, undefined, share.hostKey); } catch { /* it expires on its own */ } }
}

/** Polls the table while an offer is open: sees a viewer accept, or notices the role moved. */
async function tick() {
  const share = myShare();
  if (!pending || !share) { setPending(null); return; }
  if (Date.now() >= pending.expiresAt) { setPending(null); return; }
  try {
    const r = await call<{ offer?: PublicOffer }>('GET', `?code=${share.code}`);
    if (r.status !== 200) return;
    const offer = r.data?.offer;
    if (!offer) {
      // the offer is gone: used (we are no longer host), withdrawn, or expired
      const v = await call('POST', `?code=${share.code}&action=verify`, {}, share.hostKey);
      if (v.status === 403) { setPending(null); handedOver(share.code); } else setPending(null);
      return;
    }
    if (offer.status === 'claimed' && pending.status !== 'claimed') {
      setPending({ ...pending, status: 'claimed' });
      openHandoverSheet(); // surface the "confirm?" question wherever the host is
    } else if (offer.status === 'open' && pending.status === 'claimed') {
      setPending({ ...pending, status: 'open' });
    }
  } catch { /* offline: try again next tick */ }
}

const fmtLeft = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function offerToSeat(playerId: string, name: string) {
  const share = myShare();
  if (!share) return;
  const r = await call<{ offer?: PublicOffer; error?: string }>('POST', `?code=${share.code}&action=offer`, { kind: 'seat', playerId }, share.hostKey);
  if (r.status === 403) { handedOver(share.code); return; }
  if (r.status !== 201 || !r.data.offer) { toast(r.data?.error ?? 'Could not send the offer', 'error'); return; }
  setPending({ kind: 'seat', playerId, name, expiresAt: r.data.offer.expiresAt, status: 'open' });
}

async function offerByLink() {
  const share = myShare();
  if (!share) return;
  const r = await call<{ offer?: PublicOffer; token?: string; error?: string }>('POST', `?code=${share.code}&action=offer`, { kind: 'link' }, share.hostKey);
  if (r.status === 403) { handedOver(share.code); return; }
  if (r.status !== 201 || !r.data.offer || !r.data.token) { toast(r.data?.error ?? 'Could not create the code', 'error'); return; }
  const url = `${location.origin}${location.pathname}#/h/${share.code}.${r.data.token}`;
  setPending({ kind: 'link', url, expiresAt: r.data.offer.expiresAt, status: 'open' });
}

async function decide(approve: boolean) {
  const share = myShare();
  const who = pending?.name;
  if (!share) return;
  const r = await call('POST', `?code=${share.code}&action=approve`, { approve }, share.hostKey);
  if (r.status === 403) { setPending(null); handedOver(share.code); return; }
  if (approve && r.status === 200) { setPending(null); handedOver(share.code, who); return; }
  if (!approve && r.status === 200) { if (pending) setPending({ ...pending, status: 'open' }); toast('Declined'); return; }
  toast('That offer is no longer open', 'error');
  setPending(null);
}

let sheetOpen = false;

export function openHandoverSheet() {
  if (sheetOpen || !myShare()) return;
  sheetOpen = true;
  openSheet('Hand over the table', close => {
    const body = h('div', { class: 'sheet-body handover' });
    const redraw = () => { if (body.isConnected) draw(); };
    listeners.add(redraw);
    const clock = window.setInterval(() => {
      if (!body.isConnected) {
        clearInterval(clock);
        listeners.delete(redraw);
        sheetOpen = false;
        // a QR code is only meant to be shown while this screen is open
        if (pending?.kind === 'link') void withdraw();
        return;
      }
      const left = body.querySelector('[data-left]');
      if (left && pending) left.textContent = fmtLeft(pending.expiresAt - Date.now());
      if (pending && Date.now() >= pending.expiresAt) setPending(null);
    }, 1000);

    function draw() {
      if (!pending) {
        const players = state.session.players;
        body.replaceChildren(
          h('p', { class: 'muted', text: 'The new host takes over editing. You become a viewer, and everyone’s live link keeps working.' }),
          h('h3', { class: 'hands-h', text: 'Hand to a player in the list' }),
          players.length === 0
            ? h('p', { class: 'muted small', text: 'No players yet.' })
            : group(...players.map(p => h('button', { class: 'row action', on: { click: () => void offerToSeat(p.id, p.name) } },
                h('span', { class: 'grow', text: p.name }), h('span', { class: 'muted small', text: 'sends a request ›' })))),
          h('p', { class: 'muted small', text: 'They see “Accept” on their live view (they need to be watching the link). You then confirm here.' }),
          h('h3', { class: 'hands-h', text: 'Hand to someone new' }),
          h('button', { class: 'btn tinted block', text: '▦ Show QR code', on: { click: () => void offerByLink() } }),
          h('p', { class: 'muted small', text: 'Works for anyone, even people not in the list. One use, 10 minutes.' }),
          h('button', { class: 'btn plain block', text: 'Close', on: { click: close } }));
        return;
      }
      const left = h('strong', { class: 'mono', text: fmtLeft(pending.expiresAt - Date.now()), attrs: { 'data-left': '' } });
      if (pending.kind === 'link' && pending.url) {
        const url = pending.url;
        const input = h('input', { attrs: { type: 'text', readonly: true, value: url, 'aria-label': 'One-time hand-over link', spellcheck: false }, on: { focus: () => input.select() } });
        input.value = url;
        body.replaceChildren(
          h('p', { class: 'muted', text: 'Ask the new host to scan this with their camera, then tap “Become host”.' }),
          h('div', { class: 'qr-box' }, renderQr(url, 'QR code to take over this table')),
          h('p', { class: 'center muted small' }, 'Expires in ', left, ' · works once'),
          group(h('label', { class: 'row field' }, h('span', { text: 'Link' }), input)),
          h('div', { class: 'two' },
            h('button', { class: 'btn tinted', text: 'Copy link', on: { click: () => { void navigator.clipboard?.writeText(url).then(() => toast('Link copied'), () => toast('Could not copy', 'error')); } } }),
            h('button', { class: 'btn tinted', text: 'Share…', on: { click: () => { if (navigator.share) void navigator.share({ title: 'Take over the table', url }).catch(() => undefined); else toast('Use Copy link', 'error'); } } })),
          h('button', { class: 'btn danger block', text: 'Cancel hand-over', on: { click: () => { void withdraw(); } } }));
        return;
      }
      if (pending.status === 'claimed') {
        body.replaceChildren(
          h('p', { class: 'center' }, h('strong', { text: `${pending.name ?? 'A player'} accepted.` })),
          h('p', { class: 'muted', text: 'Make them the host? You’ll become a viewer and they can edit the table from their phone.' }),
          h('button', { class: 'btn primary block', text: `Make ${pending.name ?? 'them'} the host`, on: { click: () => { void decide(true); } } }),
          h('button', { class: 'btn plain block', text: 'Not now', on: { click: () => { void decide(false); } } }));
        return;
      }
      body.replaceChildren(
        h('p', { class: 'center' }, h('strong', { text: `Waiting for ${pending.name ?? 'the player'} to accept…` })),
        h('p', { class: 'muted small center', text: 'They need to open the live link; they will see an Accept button there.' }),
        h('p', { class: 'center muted small' }, 'Expires in ', left),
        h('button', { class: 'btn danger block', text: 'Cancel request', on: { click: () => { void withdraw(); } } }),
        h('button', { class: 'btn plain block', text: 'Close (keep waiting)', on: { click: close } }));
    }
    draw();
    return body;
  });
}

// ---------------------------------------------------------------------------------------------
// New host
// ---------------------------------------------------------------------------------------------

export const TAKEOVER_PREFIX = 'takeover:';

async function adoptFrom(code: string, key: string, snapshot: SharedSnapshot) {
  adoptSharedSession(snapshot, { code, hostKey: key });
  toast('You’re the host now');
}

/** Scanning a hand-over QR/link: confirm, then claim with the one-time token. */
export async function openTakeoverSheet(code: string, token: string) {
  history.replaceState(null, '', location.pathname);
  let title = 'this table';
  try {
    const r = await call<{ snapshot?: SharedSnapshot }>('GET', `?code=${code}`);
    if (r.status === 404) { toast('That table is no longer available', 'error'); return; }
    if (r.status === 200 && r.data.snapshot) title = `“${r.data.snapshot.name}”`;
  } catch { /* offline: the claim below will fail with a clear message */ }
  const replacing = !state.session.isDemo && state.session.players.length > 0;
  confirmSheet({
    title: 'Become the host?',
    message: `You’ll take over ${title} and can edit buy-ins and chips. The current host becomes a viewer.${replacing ? '\n\nThe table open on this phone is saved to History first.' : ''}`,
    confirmLabel: 'Become host', cancelLabel: 'Not now',
    onConfirm: async () => {
      try {
        const { key, hash } = await makeHostKey();
        const r = await call<{ snapshot?: SharedSnapshot; error?: string }>('POST', `?code=${code}&action=claim`, { token, keyHash: hash });
        if (r.status === 200 && r.data.snapshot) { await adoptFrom(code, key, r.data.snapshot); return; }
        toast(r.status === 403 || r.status === 404 ? 'This hand-over code was already used or has expired' : (r.data?.error ?? 'Could not take over'), 'error');
      } catch (e) {
        toast((e as Error).message || 'Could not reach the server', 'error');
      }
    }
  });
}

/** A viewer's accepted offer was confirmed by the host: the viewer page left a key for us to finish with. */
export async function finishPendingTakeover() {
  let found: { code: string; key: string } | null = null;
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i) ?? '';
      if (k.startsWith(TAKEOVER_PREFIX)) { found = { code: k.slice(TAKEOVER_PREFIX.length), key: sessionStorage.getItem(k) ?? '' }; break; }
    }
  } catch { return; }
  if (!found || !normalizeCode(found.code)) return;
  try {
    const r = await call<{ snapshot?: SharedSnapshot }>('GET', `?code=${found.code}`);
    if (r.status === 200 && r.data.snapshot) {
      await adoptFrom(found.code, found.key, r.data.snapshot);
      sessionStorage.removeItem(TAKEOVER_PREFIX + found.code);
    } else if (r.status === 404) {
      sessionStorage.removeItem(TAKEOVER_PREFIX + found.code);
      toast('That table is no longer available', 'error');
    }
  } catch { /* try again on the next launch; the key stays in this tab's storage */ }
}

/** Called once the host app has started. */
export function afterBoot() {
  const m = /^#\/h\/([A-Za-z0-9]{8})\.([A-Za-z0-9_-]{16,64})$/.exec(location.hash);
  if (m) { void openTakeoverSheet(m[1].toUpperCase(), m[2]); return; }
  void finishPendingTakeover();
}


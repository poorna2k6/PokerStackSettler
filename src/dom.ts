// Tiny DOM helpers. Text is only ever set via textContent / createTextNode, so
// user-supplied names can never be interpreted as HTML.

type Child = Node | string | number | null | undefined | false;
interface Props {
  class?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props?.class) el.className = props.class;
  if (props?.text !== undefined) el.textContent = props.text;
  if (props?.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (v === undefined) continue;
      // aria-* states need explicit "true"/"false"; other boolean attrs (disabled, hidden) are presence-only.
      if (typeof v === 'boolean' && k.startsWith('aria-')) { el.setAttribute(k, String(v)); continue; }
      if (v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (props?.on) {
    for (const [k, fn] of Object.entries(props.on)) el.addEventListener(k, fn as EventListener);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function haptic(ms = 8) {
  try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'ok' | 'error' = 'ok') {
  const root = document.getElementById('toast')!;
  root.textContent = message;
  root.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (root.className = 'toast'), 2400);
}

export interface SheetHandle { close(): void }

/** Bottom sheet. `build` receives a close function and returns the body. */
export function openSheet(title: string, build: (close: () => void) => Node): SheetHandle {
  const root = document.getElementById('sheets')!;
  const previous = document.activeElement as HTMLElement | null;
  const backdrop = h('div', { class: 'backdrop' });
  const sheet = h('div', { class: 'sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return; }
    // Keep Tab focus inside the topmost sheet.
    if (e.key !== 'Tab' || root.lastElementChild !== sheet) return;
    const items = [...sheet.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !sheet.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !sheet.contains(active))) { e.preventDefault(); first.focus(); }
  };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    sheet.classList.remove('in');
    backdrop.classList.remove('in');
    setTimeout(() => { sheet.remove(); backdrop.remove(); previous?.focus?.(); }, 220);
  };
  sheet.append(
    h('div', { class: 'sheet-grabber' }),
    h('div', { class: 'sheet-head' },
      h('h2', { text: title }),
      h('button', { class: 'link', text: 'Close', on: { click: close } })),
    build(close)
  );
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  root.append(backdrop, sheet);
  requestAnimationFrame(() => { sheet.classList.add('in'); backdrop.classList.add('in'); });
  (sheet.querySelector('input,button.primary') as HTMLElement | null)?.focus();
  return { close };
}

export interface ConfirmOpts {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

export function confirmSheet(o: ConfirmOpts) {
  openSheet(o.title, close =>
    h('div', { class: 'sheet-body' },
      h('p', { class: 'muted pre', text: o.message }),
      h('button', {
        class: `btn ${o.destructive ? 'danger' : 'primary'} block`,
        text: o.confirmLabel,
        on: { click: () => { close(); o.onConfirm(); } }
      }),
      h('button', { class: 'btn plain block', text: 'Cancel', on: { click: close } }))
  );
}

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

/** Called when a sheet closes and the control that opened it no longer exists (the screen was re-rendered). */
let focusFallback: (() => void) | undefined;
export const setFocusFallback = (fn: () => void) => { focusFallback = fn; };

/** Bottom sheet. `build` receives a close function and returns the body. */
export function openSheet(title: string, build: (close: () => void) => Node): SheetHandle {
  const root = document.getElementById('sheets')!;
  const previous = document.activeElement as HTMLElement | null;
  const backdrop = h('div', { class: 'backdrop' });
  const sheet = h('div', { class: 'sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } });
  const onKey = (e: KeyboardEvent) => {
    // Escape closes only the TOP sheet (a confirm opened from another sheet must not take that one down with it).
    if (e.key === 'Escape') { if (root.lastElementChild === sheet) close(); return; }
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
  const previousKey = previous?.dataset?.fk;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    sheet.style.pointerEvents = 'none'; // a closing sheet must not accept another tap during its fade-out
    sheet.classList.remove('in');
    backdrop.classList.remove('in');
    setTimeout(() => {
      sheet.remove();
      backdrop.remove();
      // Another sheet is still open (we were stacked on it): put focus back inside it, on the same control if it
      // still exists (it may have been redrawn), otherwise on its first control.
      const top = [...root.querySelectorAll<HTMLElement>('.sheet')].pop();
      if (top) {
        if (!top.contains(document.activeElement)) {
          const same = previousKey ? top.querySelector<HTMLElement>(`[data-fk="${previousKey}"]`) : null;
          const target = (previous && top.contains(previous) ? previous : same) ?? top.querySelector<HTMLElement>('button, input');
          target?.focus({ preventScroll: true });
        }
        return;
      }
      if (previous?.isConnected) previous.focus();
      else focusFallback?.();
    }, 220);
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
  // focus the first useful control; if there is none, the dialog itself, so Enter/Space never act on the page behind it
  sheet.tabIndex = -1;
  ((sheet.querySelector('input, button.primary, button.danger') ?? sheet.querySelector('.sheet-body button')) as HTMLElement | null ?? sheet).focus({ preventScroll: true });
  return { close };
}

/** Closes every open sheet at once (used when the situation under them changed, e.g. the host role moved). */
export function closeAllSheets() {
  const root = document.getElementById('sheets');
  if (!root) return;
  for (const el of [...root.children]) {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 220);
  }
}

export interface ConfirmOpts {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}

export function confirmSheet(o: ConfirmOpts) {
  let confirmed = false;
  openSheet(o.title, close =>
    h('div', { class: 'sheet-body' },
      h('p', { class: 'muted pre', text: o.message }),
      h('button', {
        class: `btn ${o.destructive ? 'danger' : 'primary'} block`,
        text: o.confirmLabel,
        on: { click: () => { if (confirmed) return; confirmed = true; close(); o.onConfirm(); } } // a double-tap must act once
      }),
      h('button', { class: 'btn plain block', text: o.cancelLabel ?? 'Cancel', on: { click: close } }))
  );
}

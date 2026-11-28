// "Extra expenses" (food, drinks…): the list, the add/edit form and the End & settle question.
import { h, haptic, openSheet, confirmSheet, toast } from './dom';
import { formatCurrency, toCents, MAX_BILLS } from './engine';
import { audit, checkBill, previewAudit, removeBill, saveBill, state, subscribe } from './state';
import { amountCol, group } from './ui';

const payerName = (b: { payerId?: string; guest?: string }) =>
  (b.payerId && state.session.players.find(p => p.id === b.payerId)?.name) || b.guest || 'Someone else';

/** The list of expenses. `onDone` runs after the person taps Done (used by the End & settle flow). */
export function openExpenses(onDone?: () => void) {
  openSheet('Extra expenses', close => {
    const body = h('div', { class: 'sheet-body' });
    const stop = subscribe(() => { if (!body.isConnected) stop(); else draw(); });
    const draw = () => {
      const s = state.session;
      const bills = s.bills ?? [];
      const locked = s.isEnded;
      const a = audit();
      const unbalanced = !a.isBalanced;
      body.replaceChildren(
        h('p', { class: 'muted small', text: 'Food, drinks or anything else paid by a player — or by someone who isn’t playing. Each expense is split equally between the people you choose (everyone by default) and added to who pays whom. Chips and poker results are not changed.' }),
        bills.length === 0
          ? group(h('div', { class: 'row empty' }, h('span', { text: 'No extra expenses yet.' })))
          : group(
            ...bills.map(b => h(locked ? 'div' : 'button', {
              class: locked ? 'row' : 'row action', attrs: { 'data-fk': `bill:${b.id}`, 'aria-label': `${b.label}, ${formatCurrency(b.cents)}, paid by ${payerName(b)}${locked ? '' : ', edit'}`, disabled: locked },
              on: locked ? {} : { click: () => openBillForm(b.id) }
            },
              h('span', { class: 'grow' }, h('strong', { text: b.label }), h('div', { class: 'muted small', text: `paid by ${payerName(b)} · ${b.sharedBy?.length ? `shared by ${b.sharedBy.length}` : 'everyone'}` })),
              h('span', { class: 'mono', text: formatCurrency(b.cents) }))),
            h('div', { class: 'row' },
              h('span', { class: 'muted grow', text: 'Total' }),
              h('strong', { class: 'mono', text: formatCurrency(a.billsTotalCents) }))),
        ...(bills.length ? [h('div', { class: 'section-title' }, h('span', { text: 'Per person: poker → after expenses' })), ...(unbalanced ? [h('p', { class: 'muted small', text: 'The chips don’t balance yet, so these amounts will change once they do.' })] : []), group(
          ...a.players.map(p => h('div', { class: 'row' }, h('span', { class: 'grow', text: p.name }), amountCol(p.netCents, p.finalCents))),
          ...a.guests.map(g => h('div', { class: 'row' }, h('span', { class: 'grow', text: `${g.name} (not playing)` }), amountCol(0, g.finalCents))))] : []),
        ...(!locked && bills.length >= MAX_BILLS ? [h('p', { class: 'muted small', text: `You can add up to ${MAX_BILLS} expenses. Delete one to add another.` })] : []),
        ...(locked ? [h('p', { class: 'muted small', text: 'The session is settled and locked. Reopen it on the Table tab to change expenses.' })] : [h('button', { class: 'btn tinted block', text: '＋ Add expense', attrs: { disabled: bills.length >= MAX_BILLS }, on: { click: () => openBillForm() } })]),
        h('button', { class: `btn ${onDone ? 'primary' : 'plain'} block`, text: onDone ? 'Continue' : 'Done', on: { click: () => { close(); onDone?.(); } } }));
    };
    draw();
    return body;
  });
}

function openBillForm(id?: string) {
  const s = state.session;
  const existing = id ? (s.bills ?? []).find(b => b.id === id) : undefined;
  if (id && !existing) return;
  openSheet(existing ? 'Edit expense' : 'Add expense', close => {
    const label = h('input', { attrs: { type: 'text', placeholder: 'Pizza, drinks…', maxlength: 40, autocomplete: 'off', 'aria-label': 'What was it for', value: existing?.label ?? '' } });
    const amount = h('input', { attrs: { type: 'text', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off', 'aria-label': 'Amount in dollars', value: existing ? (existing.cents / 100).toFixed(2) : '' } });
    label.value = existing?.label ?? '';
    amount.value = existing ? (existing.cents / 100).toFixed(2) : '';
    let payerId: string | undefined = existing?.payerId;
    let someoneElse = !!existing && !existing.payerId;
    const guest = h('input', { attrs: { type: 'text', placeholder: 'Name of the person who paid', maxlength: 40, autocomplete: 'off', 'aria-label': 'Name of the person who paid' } });
    guest.value = existing?.guest ?? '';
    const error = h('p', { class: 'bad small', attrs: { role: 'alert' } });
    const paidBy = h('p', { class: 'paid-by small', attrs: { 'aria-live': 'polite' } });
    // who shares it: every player (default) or just the ticked ones; guests who already paid something can be ticked too
    const guestOpts = [...new Map((s.bills ?? []).filter(b => !b.payerId && b.guest && b.id !== existing?.id).map(b => [b.guest!.trim().toLowerCase(), b.guest!])).entries()]
      .filter(([k]) => !s.players.some(p => p.name.trim().toLowerCase() === k));
    const playerIds = s.players.map(p => p.id);
    let sharing = new Set<string>(existing?.sharedBy?.length ? existing.sharedBy : playerIds);
    const shareRow = h('div', { class: 'seg-row wrap', attrs: { role: 'group', 'aria-label': 'Who shares this expense' } });
    const shareNote = h('p', { class: 'muted small', attrs: { 'aria-live': 'polite' } });
    const keepFocus = (box: HTMLElement, redraw: () => void) => {
      const i = [...box.children].indexOf(document.activeElement as Element);
      redraw();
      if (i >= 0) (box.children[i] as HTMLElement | undefined)?.focus();
    };
    const drawShare0 = () => {
      const all = playerIds.every(id => sharing.has(id)) && guestOpts.every(([k]) => !sharing.has(`guest:${k}`));
      shareRow.replaceChildren(
        h('button', { class: `chip ${all ? 'on' : ''}`, text: `${all ? '✓ ' : ''}Everyone`, attrs: { 'aria-pressed': all }, on: { click: () => { sharing = new Set(playerIds); drawShare(); } } }),
        ...s.players.map(p => { const on = sharing.has(p.id); return h('button', { class: `chip ${on ? 'on' : ''}`, text: `${on ? '✓ ' : ''}${p.name}`, attrs: { 'aria-pressed': on }, on: { click: () => { if (on) sharing.delete(p.id); else sharing.add(p.id); drawShare(); } } }); }),
        ...guestOpts.map(([k, name]) => { const id = `guest:${k}`; const on = sharing.has(id); return h('button', { class: `chip ${on ? 'on' : ''}`, text: `${on ? '✓ ' : ''}${name} (not playing)`, attrs: { 'aria-pressed': on }, on: { click: () => { if (on) sharing.delete(id); else sharing.add(id); drawShare(); } } }); }));
      const n = sharing.size;
      shareNote.textContent = n === 0 ? 'Pick at least one person.' : all ? 'Shared equally by everyone who played.' : `Shared equally by ${n} ${n === 1 ? 'person' : 'people'}.`;
    };
    const drawShare = () => keepFocus(shareRow, drawShare0);
    drawShare0();
    const labels = h('div', { class: 'seg-row wrap', attrs: { 'aria-label': 'Quick labels' } },
      ...['Pizza', 'Drinks', 'Snacks', 'Beer', 'Tip'].map(t => h('button', { class: 'chip', text: t, on: { click: () => { label.value = t; amount.focus(); } } })));
    const chips = h('div', { class: 'seg-row wrap', attrs: { role: 'radiogroup', 'aria-label': 'Who paid' } });
    const guestRow = h('label', { class: 'row field' }, h('span', { text: 'Name' }), guest);
    const drawChips0 = () => {
      paidBy.textContent = someoneElse ? (guest.value.trim() ? `Paid by ${guest.value.trim()} (not playing)` : 'Type the name of the person who paid') : payerId ? `Paid by ${s.players.find(p => p.id === payerId)?.name ?? ''}` : 'Pick who paid';
      chips.replaceChildren(
        ...s.players.map(p => h('button', {
          class: `chip ${!someoneElse && payerId === p.id ? 'on' : ''}`, text: `${!someoneElse && payerId === p.id ? '✓ ' : ''}${p.name}`,
          attrs: { role: 'radio', 'aria-checked': !someoneElse && payerId === p.id },
          on: { click: () => { payerId = p.id; someoneElse = false; drawChips(); } }
        })),
        h('button', {
          class: `chip ${someoneElse ? 'on' : ''}`, text: `${someoneElse ? '✓ ' : ''}Someone else…`,
          attrs: { role: 'radio', 'aria-checked': someoneElse },
          on: { click: () => { someoneElse = true; payerId = undefined; drawChips(); guest.focus(); } }
        }));
      guestRow.hidden = !someoneElse;
    };
    const drawChips = () => keepFocus(chips, drawChips0);
    drawChips0();
    const submit = () => {
      const input = {
        label: label.value, cents: toCents(amount.value),
        ...(someoneElse ? { guest: guest.value } : payerId ? { payerId } : {}),
        ...(sharing.size && !(playerIds.every(id => sharing.has(id)) && guestOpts.every(([k]) => !sharing.has(`guest:${k}`))) ? { sharedBy: [...sharing] } : {})
      };
      if (sharing.size === 0) { error.textContent = 'Pick at least one person to share this expense.'; return; }
      const err = saveBill(input, existing?.id);
      if (err) { error.textContent = err; return; }
      haptic();
      close();
    };
    guest.addEventListener('input', () => drawChips());
    for (const el of [label, amount, guest]) el.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    return h('div', { class: 'sheet-body' },
      labels,
      group(
        h('label', { class: 'row field' }, h('span', { text: 'What' }), label),
        h('label', { class: 'row field' }, h('span', { text: 'Amount ($)' }), amount)),
      h('div', { class: 'section-title' }, h('span', { text: 'Who paid?' })),
      chips, group(guestRow), paidBy,
      h('div', { class: 'section-title' }, h('span', { text: 'Who shares it?' })),
      shareRow, shareNote,
      error,
      h('button', { class: 'btn primary block', text: existing ? 'Save changes' : 'Add expense', on: { click: submit } }),
      ...(existing ? [h('button', { class: 'btn danger block', text: 'Delete expense', on: { click: () => { close(); confirmSheet({
        title: 'Delete this expense?', message: `${existing.label} · ${formatCurrency(existing.cents)}`, confirmLabel: 'Delete', destructive: true,
        onConfirm: () => { removeBill(existing.id); toast('Expense deleted'); }
      }); } } })] : []));
  });
}

/**
 * The question asked when someone taps End & settle and no expenses were entered yet.
 * `proceed` continues with the normal chip check / confirmation.
 */
export function askExtraExpenses(proceed: () => void) {
  openSheet('Any extra expenses?', close => h('div', { class: 'sheet-body' },
    h('p', { class: 'muted', text: 'Was there food, drinks or anything else paid by a player — or by someone who isn’t playing? It will be split between the people you choose and added to the settlement.' }),
    h('button', { class: 'btn primary block', text: 'No extra expenses', on: { click: () => { close(); proceed(); } } }),
    h('button', { class: 'btn tinted block', text: 'Yes, add expenses', on: { click: () => { close(); openExpenses(proceed); } } }),
    h('button', { class: 'btn plain block', text: 'Not now', on: { click: close } })));
}

/** One line per person for the confirmation: poker + expenses = final. */
export function previewLines(): string {
  const a = previewAudit();
  if (a.billsTotalCents === 0) return '';
  const lines = a.players.map(p => `${p.name}: ${formatCurrency(p.netCents, true)} poker ${p.paidCents - p.shareCents >= 0 ? '+' : '−'} ${formatCurrency(Math.abs(p.paidCents - p.shareCents))} food = ${formatCurrency(p.finalCents, true)}`);
  a.guests.forEach(g => lines.push(`${g.name} (not playing): ${formatCurrency(g.finalCents, true)}`));
  return `Extra expenses ${formatCurrency(a.billsTotalCents)}, split as chosen:\n${lines.join('\n')}\n\n`;
}

export { checkBill };

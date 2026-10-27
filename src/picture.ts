// "Save as picture": draws the final settlement on a canvas so it can be posted in a group chat.
import type { Audit } from './engine';
import { formatCurrency } from './engine';
import { toast } from './dom';

const W = 1080;
const PAD = 64;

function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

export function drawSettlement(title: string, audit: Audit, paid: (key: string) => boolean): HTMLCanvasElement {
  const transfers = audit.transfers;
  const standings = [...audit.players].sort((a, b) => b.netCents - a.netCents);
  const head = 250;
  const rowT = 84;
  const rowS = 64;
  const H = head + 90 + Math.max(1, transfers.length) * rowT + 110 + standings.length * rowS + 130;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const serif = '"Playfair Display", Georgia, "Times New Roman", serif';
  const sans = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const mono = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0f5a3d');
  bg.addColorStop(1, '#06281c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#e8c55b';
  ctx.lineWidth = 6;
  ctx.strokeRect(24, 24, W - 48, H - 48);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e8c55b';
  ctx.font = `700 78px ${serif}`;
  ctx.fillText('♠ Settlement', PAD, 140);
  ctx.fillStyle = '#ffffff';
  ctx.font = `500 40px ${sans}`;
  ctx.fillText(fit(ctx, title, W - PAD * 2), PAD, 202);
  ctx.fillStyle = '#a8c4b5';
  ctx.font = `500 30px ${sans}`;
  ctx.fillText(`Pot ${formatCurrency(audit.totalBuyInCents)} · ${audit.players.length} players`, PAD, 244);

  let y = head + 70;
  ctx.fillStyle = '#e8c55b';
  ctx.font = `700 34px ${sans}`;
  ctx.fillText('WHO PAYS WHOM', PAD, y);
  y += 26;
  if (transfers.length === 0) {
    ctx.fillStyle = '#ffffff';
    ctx.font = `500 38px ${sans}`;
    ctx.fillText('No payments needed 🎉', PAD, y + 56);
    y += rowT;
  }
  for (const t of transfers) {
    const done = paid(`${t.id}:${t.amountCents}`);
    ctx.globalAlpha = done ? 0.6 : 1;
    ctx.font = `600 38px ${sans}`;
    const amount = formatCurrency(t.amountCents);
    ctx.font = `700 40px ${mono}`;
    const aw = ctx.measureText(amount).width;
    ctx.font = `600 38px ${sans}`;
    const room = W - PAD * 2 - aw - 40 - (done ? 60 : 0);
    const from = fit(ctx, t.fromName, room * 0.42);
    const to = fit(ctx, t.toName, room * 0.42);
    ctx.fillStyle = '#ff9a90';
    ctx.fillText(from, PAD, y + 56);
    let x = PAD + ctx.measureText(from).width;
    ctx.fillStyle = '#a8c4b5';
    ctx.fillText(' → ', x, y + 56);
    x += ctx.measureText(' → ').width;
    ctx.fillStyle = t.isHouse ? '#a5b4fc' : '#5eea8f';
    ctx.fillText(to, x, y + 56);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 40px ${mono}`;
    ctx.textAlign = 'right';
    ctx.fillText(amount, W - PAD - (done ? 60 : 0), y + 56);
    if (done) {
      ctx.fillStyle = '#5eea8f';
      ctx.font = `700 40px ${sans}`;
      ctx.fillText('✓', W - PAD, y + 56);
    }
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
    y += rowT;
  }

  y += 40;
  ctx.fillStyle = '#e8c55b';
  ctx.font = `700 34px ${sans}`;
  ctx.fillText('STANDINGS', PAD, y);
  y += 20;
  standings.forEach((p, i) => {
    ctx.font = `600 36px ${sans}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${i === 0 && p.netCents > 0 ? '🏆' : `${i + 1}.`} ${fit(ctx, p.name, 560)}`, PAD, y + 48);
    ctx.font = `700 36px ${mono}`;
    ctx.fillStyle = p.netCents > 0 ? '#5eea8f' : p.netCents < 0 ? '#ff9a90' : '#a8c4b5';
    ctx.textAlign = 'right';
    ctx.fillText(formatCurrency(p.netCents, true), W - PAD, y + 48);
    ctx.textAlign = 'left';
    y += rowS;
  });

  ctx.fillStyle = '#a8c4b5';
  ctx.font = `500 26px ${sans}`;
  ctx.fillText('StackSettle Pro', PAD, H - 56);
  return canvas;
}

/** Shares the picture (phones) or downloads it (desktop). */
export async function sharePicture(canvas: HTMLCanvasElement, filename: string, title: string) {
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
  if (!blob) { toast('Could not make the picture', 'error'); return; }
  const file = new File([blob], filename, { type: 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('Picture saved');
}

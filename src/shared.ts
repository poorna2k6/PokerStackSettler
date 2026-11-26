// Types and validation shared by the app (host + viewer) and the /api/share function.
import { sanitizeBills, sanitizeLog, sanitizeBuyIn, sanitizePaid, sanitizePlayers, safeCents, type Bill, type LogEntry, type Player } from './engine';

export interface SharedSnapshot {
  name: string;
  defaultBuyIn: number;
  expenseCents: number;
  isEnded: boolean;
  players: Player[];
  paid: Record<string, boolean>;
  bills?: Bill[];
  log?: LogEntry[];
  /** a message from the host to everyone watching */
  note?: string;
  /** transfers are rounded to whole dollars */
  round?: boolean;
  /** set by the server on every write */
  updatedAt: number;
}

/** Share codes avoid look-alike characters (no 0/O, 1/I). 32 symbols x 8 = 40 bits. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
/** A pending "hand the table over" offer, as viewers may see it (never includes any secret). */
export interface PublicOffer {
  /** 'seat': offered to a player in the list (they accept, the host confirms). 'link': one-time QR/link for anyone. */
  kind: 'seat' | 'link';
  playerId?: string;
  expiresAt: number;
  status: 'open' | 'claimed';
}
export const OFFER_TTL_MS = 10 * 60 * 1000;
export const KEY_HASH_RE = /^[a-f0-9]{64}$/;

export const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** What the host may pick. Every choice is a rolling lifetime counted from the host's last change. */
export const SHARE_TTL_CHOICES: { seconds: number; label: string }[] = [
  { seconds: 24 * 3600, label: '24 hours' },
  { seconds: 7 * 24 * 3600, label: '7 days' },
  { seconds: 30 * 24 * 3600, label: '30 days' },
  { seconds: 90 * 24 * 3600, label: 'Until I stop it (90-day safety limit)' }
];
/** How long the FINAL (settled) link stays alive, counted from the moment the host settles; no renewing after that. */
export const FINAL_TTL_CHOICES: { seconds: number; label: string }[] = [
  { seconds: 24 * 3600, label: '24 hours' },
  { seconds: 3 * 24 * 3600, label: '3 days' },
  { seconds: 7 * 24 * 3600, label: '7 days' },
  { seconds: 30 * 24 * 3600, label: '30 days' }
];
export const pickFinalTtl = (raw: unknown, fallback = 7 * 24 * 3600) =>
  FINAL_TTL_CHOICES.some(c => c.seconds === raw) ? (raw as number) : fallback;
export const MAX_NOTE = 240;

/** Only a listed lifetime is accepted from a client; anything else falls back to `fallback`. */
export const pickTtl = (raw: unknown, fallback = SHARE_TTL_SECONDS) =>
  SHARE_TTL_CHOICES.some(c => c.seconds === raw) ? (raw as number) : fallback;

export function normalizeCode(raw: unknown): string | null {
  const code = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Returns a clean snapshot, or null if the payload is not a usable session. */
export function sanitizeSnapshot(raw: unknown, now = Date.now()): SharedSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.players)) return null;
  return {
    name: String(typeof o.name === 'string' ? o.name : 'Poker Session').trim().slice(0, 80) || 'Poker Session',
    defaultBuyIn: sanitizeBuyIn(o.defaultBuyIn),
    expenseCents: safeCents(o.expenseCents),
    isEnded: o.isEnded === true,
    players: sanitizePlayers(o.players),
    paid: sanitizePaid(o.paid),
    bills: sanitizeBills(o.bills),
    log: sanitizeLog(o.log),
    note: typeof o.note === 'string' ? o.note.trim().slice(0, MAX_NOTE) : '',
    round: o.round === true,
    updatedAt: now
  };
}

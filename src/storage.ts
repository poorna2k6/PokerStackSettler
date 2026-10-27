import { sanitizeBuyIn, sanitizePlayers, sanitizeSaved, toCents, type SavedSession, type SessionData } from './engine';

const VAULT_KEY = 'stacksettle_pro_vault_v2';
const LIVE_KEY = 'stacksettle_live_autosave_v1';
const THEME_KEY = 'stacksettle_theme_v1';

export const THEMES = ['midnight', 'felt', 'ocean', 'light'] as const;
export type Theme = (typeof THEMES)[number];

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY) as Theme | null;
    if (t && (THEMES as readonly string[]).includes(t)) return t;
  } catch { /* ignore */ }
  return 'midnight';
}
export const saveTheme = (t: Theme) => write(THEME_KEY, t);

/** Reads the live session. Also understands the v1 single-file app's format. */
export function loadLive(): SessionData | null {
  const o = read(LIVE_KEY) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const players = sanitizePlayers(o.players);
  if (players.length === 0) return null;
  const legacyExpense = o.expenseDollars !== undefined ? toCents(o.expenseDollars) : 0;
  const expenseCents = o.expenseCents !== undefined ? Math.max(0, Math.round(Number(o.expenseCents)) || 0) : legacyExpense;
  const paid: Record<string, boolean> = {};
  if (o.paid && typeof o.paid === 'object') {
    for (const [k, v] of Object.entries(o.paid as Record<string, unknown>)) if (v === true) paid[k] = true;
  }
  return {
    id: typeof o.sessionId === 'string' ? o.sessionId : typeof o.id === 'string' ? o.id : 'sess_live',
    name: String(o.sessionName ?? o.name ?? 'Poker Session').slice(0, 80),
    defaultBuyIn: sanitizeBuyIn(o.defaultBuyIn),
    expenseCents,
    isEnded: o.isEnded === true,
    players,
    paid
  };
}

export const saveLive = (s: SessionData) =>
  write(LIVE_KEY, {
    id: s.id, name: s.name, defaultBuyIn: s.defaultBuyIn, expenseCents: s.expenseCents,
    isEnded: s.isEnded, players: s.players, paid: s.paid
  });

export function loadVault(): SavedSession[] {
  const raw = read(VAULT_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeSaved).filter((s): s is SavedSession => s !== null);
}
export const saveVault = (v: SavedSession[]) => write(VAULT_KEY, v);

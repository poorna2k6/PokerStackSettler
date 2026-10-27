// A new host generates their own secret key on their own phone; only its SHA-256 is ever sent to the server.
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function makeHostKey(): Promise<{ key: string; hash: string }> {
  if (!globalThis.crypto?.subtle) throw new Error('A secure (https) connection is needed to become host.');
  const raw = crypto.getRandomValues(new Uint8Array(24));
  const key = b64url(raw);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  const hash = [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
  return { key, hash };
}

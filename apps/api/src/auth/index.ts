import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';
// Mirrors dev.max.ru/docs/webapps/validation: split on "&" and "=", decodeURIComponent each value (not
// URLSearchParams, which would also turn "+" into a space), sort by key, join with "\n", compare the hex
// HMAC-SHA256 keyed by HMAC-SHA256("WebAppData", bot token). MAX recommends a one-hour auth_date window.
export function validateInitData(raw: string, token: string, maxAge = 3600, now = Date.now()) {
  const fail = () => new AppError('UNAUTHORIZED', 'Откройте приложение заново из MAX', 401);
  if (!token || !raw || raw.length > 16000) throw fail();
  const fields = new Map<string, string>();
  for (const pair of raw.split('&')) {
    const at = pair.indexOf('='); if (at <= 0) throw fail();
    const key = pair.slice(0, at);
    if (fields.has(key)) throw fail();
    try { fields.set(key, decodeURIComponent(pair.slice(at + 1))); } catch { throw fail(); }
  }
  const hash = fields.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw fail();
  fields.delete('hash');
  const data = [...fields.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(data).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw fail();
  const age = now / 1000 - Number(fields.get('auth_date'));
  if (!fields.has('auth_date') || !Number.isFinite(age) || age < -30 || age > maxAge) throw fail();
  try {
    const user = JSON.parse(fields.get('user') ?? '{}');
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.first_name !== 'string') throw fail();
    return { id: `max:${user.id}`, name: user.first_name.slice(0, 60), maxId: user.id as number };
  } catch { throw fail(); }
}
export function equalSecret(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length > 0 && x.length === y.length && timingSafeEqual(x, y); }
// Browser guests get a signed, self-contained cookie, so sessions survive restarts and need no server-side store.
export function guestSecret(botToken: string) { return createHmac('sha256', 'okno-guest').update(botToken || randomBytes(32)).digest(); }
export function signGuest(identity: { id: string; name: string }, secret: Buffer, ttlSeconds: number, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ id: identity.id, name: identity.name, exp: Math.floor(now / 1000) + ttlSeconds })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function verifyGuest(token: string, secret: Buffer, now = Date.now()) {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined || token.length > 1000) return null;
  if (!equalSecret(signature, createHmac('sha256', secret).update(payload).digest('base64url'))) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof value.id !== 'string' || !value.id.startsWith('guest:') || typeof value.name !== 'string' || !(value.exp > now / 1000)) return null;
    return { id: value.id as string, name: value.name as string };
  } catch { return null; }
}

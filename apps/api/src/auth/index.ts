import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';
export function validateInitData(raw: string, token: string, maxAge = 86400, now = Date.now()) {
  const fail = () => new AppError('UNAUTHORIZED', 'Откройте приложение заново из MAX', 401);
  if (!token || !raw || raw.length > 16000) throw fail();
  const p = new URLSearchParams(raw);
  for (const k of p.keys()) if (p.getAll(k).length !== 1) throw fail();
  const hash = p.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw fail();
  p.delete('hash');
  const data = [...p.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(data).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw fail();
  const age = now / 1000 - Number(p.get('auth_date'));
  if (!p.has('auth_date') || !Number.isFinite(age) || age < -30 || age > maxAge) throw fail();
  try {
    const user = JSON.parse(p.get('user') ?? '{}');
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.first_name !== 'string') throw fail();
    return { id: `max:${user.id}`, name: user.first_name.slice(0, 60), maxId: user.id as number };
  } catch { throw fail(); }
}
export function equalSecret(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length > 0 && x.length === y.length && timingSafeEqual(x, y); }

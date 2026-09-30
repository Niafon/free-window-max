import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { validateInitData, guestSecret, signGuest, verifyGuest } from '../apps/api/src/auth/index.js';
const token = 'unit-test-only';
function signed(extra: Record<string, string> = {}) { const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 123, first_name: 'Тест' }), ...extra }); p.sort(); const secret = createHmac('sha256', 'WebAppData').update(token).digest(); p.set('hash', createHmac('sha256', secret).update([...p].map(([k, v]) => `${k}=${v}`).join('\n')).digest('hex')); return p.toString(); }
describe('MAX initData', () => {
  it('Принимает подписанные параметры', () => expect(validateInitData(signed(), token).id).toBe('max:123'));
  it('Отвергает подмену пользователя', () => expect(() => validateInitData(signed().replace('123', '456'), token)).toThrow());
  it('Отвергает дубли полей', () => expect(() => validateInitData(signed() + '&auth_date=123', token)).toThrow());
  it('Отвергает просроченные параметры', () => expect(() => validateInitData(signed({ auth_date: '1' }), token)).toThrow());
  it('Отвергает параметры из будущего', () => expect(() => validateInitData(signed({ auth_date: String(Math.floor(Date.now() / 1000) + 1000) }), token)).toThrow());
  it('Отвергает невалидный JSON и неверный токен', () => { expect(() => validateInitData(signed({ user: 'null' }), token)).toThrow(); expect(() => validateInitData(signed(), 'other-test')).toThrow(); });
});
describe('Гостевой вход в браузере', () => {
  const secret = guestSecret(token), guest = { id: 'guest:abc', name: 'Гость 1234' };
  it('Принимает свою подпись', () => expect(verifyGuest(signGuest(guest, secret, 60), secret)).toEqual(guest));
  it('Отвергает подмену, чужой ключ и истёкший срок', () => {
    const [payload, signature] = signGuest(guest, secret, 60).split('.');
    const forged = Buffer.from(JSON.stringify({ id: 'max:1', name: 'x', exp: 9e9 })).toString('base64url');
    expect(verifyGuest(`${forged}.${signature}`, secret)).toBeNull();
    expect(verifyGuest(`${payload}.${signature}`, guestSecret('other-test'))).toBeNull();
    expect(verifyGuest(signGuest(guest, secret, 60, Date.now() - 120000), secret)).toBeNull();
    expect(verifyGuest('garbage', secret)).toBeNull();
  });
});

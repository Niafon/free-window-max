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
describe('MAX initData — разбор строго по документации', () => {
  // Signed exactly as dev.max.ru/docs/webapps/validation: values are URL-decoded, "+" stays a plus.
  const sign = (fields: Record<string, string>) => {
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    const data = Object.entries(fields).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
    const hash = createHmac('sha256', secret).update(data).digest('hex');
    return Object.entries(fields).map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2B/g, '+')}`).join('&') + `&hash=${hash}`;
  };
  const base = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: '4c0ab423-342b-4e45-aea4-2747dbc500cd', chat: '{"id":12345,"type":"DIALOG"}', user: '{"id":67890,"first_name":"Анна Мария","last_name":"User","username":null,"language_code":"ru","photo_url":null}' };
  it('Принимает пример из документации с chat, query_id и пробелом в имени', () => expect(validateInitData(sign(base), token)).toMatchObject({ id: 'max:67890', name: 'Анна Мария' }));
  it('Литеральный «+» остаётся плюсом, а не пробелом', () => expect(validateInitData(sign({ ...base, start_param: 'a+b' }), token).id).toBe('max:67890'));
  it('Подпись старше часа отвергается по умолчанию', () => expect(() => validateInitData(sign({ ...base, auth_date: String(Math.floor(Date.now() / 1000) - 3700) }), token)).toThrow());
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

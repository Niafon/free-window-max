import { describe, it, expect } from 'vitest';
import { parseWindow, moscowDay } from '../apps/api/src/max/bot.js';
const now = Date.parse('2026-09-30T10:00:00+03:00');
describe('Окно из текста в чате', () => {
  it('Сегодня по умолчанию', () => expect(parseWindow('18:30–21:30', now)).toEqual({ from: '2026-09-30T18:30:00+03:00', to: '2026-09-30T21:30:00+03:00' }));
  it('Завтра и дефис', () => expect(parseWindow('завтра 9:00-12:00', now)).toEqual({ from: '2026-10-01T09:00:00+03:00', to: '2026-10-01T12:00:00+03:00' }));
  it('Дата дд.мм', () => expect(parseWindow('02.10 18:00—21:00', now)?.from).toBe('2026-10-02T18:00:00+03:00'));
  it('Прошедшая дата года переносится на следующий год', () => expect(parseWindow('01.01 18:00–21:00', now)?.from).toBe('2027-01-01T18:00:00+03:00'));
  it('Окно через полночь заканчивается на следующий день', () => expect(Date.parse(parseWindow('22:00–01:00', now)!.to)).toBe(Date.parse('2026-10-01T01:00:00+03:00')));
  it('Отвергает мусор', () => { expect(parseWindow('вечером', now)).toBeNull(); expect(parseWindow('25:00–26:00', now)).toBeNull(); });
  it('Московский день', () => expect(moscowDay(0, Date.parse('2026-09-30T22:30:00Z'))).toBe('2026-10-01'));
});

import { describe, it, expect } from 'vitest';
import { commonWindow, evaluate, recommend } from '../apps/api/src/recommendation/engine.js';
import { parsePrice } from '../apps/api/src/providers/kudago.js';
import { event, member, pref, testDate, travel } from './fixtures.js';
describe('Выполнимость — сценарии A–G', () => {
  it('A: возвращает выполнимое событие с дорогой обратно и запасом', () => { const r = evaluate(event, [member()], [travel]); expect(r.candidate?.members[0].returnAt).toBe(`${testDate}T17:30:00.000Z`); expect(r.candidate?.totalPrice).toBe(650); });
  it('B: 45 минут дороги к событию в 19:00 исключают его', () => expect(evaluate(event, [member()], [{ ...travel, outbound: 45 }]).candidate).toBeUndefined());
  it('C: цена 1500 при бюджете 1000 исключена', () => expect(evaluate({ ...event, priceMax: 1500 }, [member()], [travel]).reasons).toContain('Выше бюджета'));
  it('D: пересечение 18–22 и 19–21 даёт 19–21', () => { const w = commonWindow([member({ availableFrom: `${testDate}T18:00:00+03:00`, availableTo: `${testDate}T22:00:00+03:00` }), member({ availableFrom: `${testDate}T19:00:00+03:00` })]); expect(w.from).toBe(Date.parse(`${testDate}T19:00:00+03:00`)); expect(w.to).toBe(Date.parse(`${testDate}T21:00:00+03:00`)); });
  it('E: если другу ехать 42 минуты при лимите 30, группа не проходит', () => expect(evaluate(event, [member(), member({}, 'Друг')], [travel, { ...travel, outbound: 42 }]).candidate).toBeUndefined());
  it('Проверяет обратную дорогу отдельно', () => expect(evaluate(event, [member()], [{ ...travel, inbound: 40 }]).reasons).toContain('Дорога дольше лимита'));
  it('Учитывает проезд в бюджете каждого участника', () => expect(evaluate(event, [member({ transportBudget: 500 })], [travel]).candidate).toBeUndefined());
  it.each(['unknown-price', 'sold-out', 'age', 'excluded'])('Не допускает %s', kind => {
    const e = { ...event, ...(kind === 'unknown-price' ? { priceKnown: false, priceMax: null } : {}), ...(kind === 'sold-out' ? { availability: 'sold_out' as const } : {}), ...(kind === 'age' ? { ageRestriction: 21 } : {}) };
    expect(evaluate(e, [member(kind === 'excluded' ? { excludedCategories: ['games'] } : {})], [travel]).candidate).toBeUndefined();
  });
  it('Оценочная длительность видна в предупреждениях', () => expect(evaluate({ ...event, estimate: 'end' }, [member()], [travel]).candidate?.warnings[0]).toContain('это оценка'));
  it('Свободное посещение учитывает закрытие', () => { expect(evaluate({ ...event, flexible: true, durationMinutes: 90 }, [member()], [travel]).reasons).toContain('Не хватает времени до закрытия'); });
  it('F: при сбое маршрутизатора нет выдуманного времени', async () => { await expect(recommend([event], [member()], { getRoute: async () => { throw new Error('Timeout'); } })).rejects.toMatchObject({ code: 'ROUTE_PROVIDER_ERROR' }); });
  it('G: основной сценарий не использует LLM и детерминирован', async () => { const provider = { getRoute: async () => travel }; const a = await recommend([event], [member()], provider); const b = await recommend([event], [member()], provider); expect(a.results).toEqual(b.results); });
  it('При пустой выдаче предлагает проверенный рост бюджета', async () => { const r = await recommend([event], [member({ budget: 500 })], { getRoute: async () => travel }); expect(r.results).toHaveLength(0); expect(r.compromises).toContainEqual({ field: 'budget', value: 200, count: 1, label: 'Бюджет каждого +200 ₽' }); });
  it('Нет общего окна — нет обращений к маршрутам', async () => { const r = await recommend([event], [member({ availableTo: `${testDate}T19:00:00+03:00` }), member({ availableFrom: `${testDate}T20:00:00+03:00` })], { getRoute: async () => { throw new Error('Must not be called'); } }); expect(r.commonWindow).toBeNull(); expect(r.notices[0]).toContain('Общего окна нет'); });
  it('Граничные комбинации никогда не нарушают бюджет или окно', () => {
    for (const budget of [0, 649, 650, 1000]) for (const out of [0, 20, 21, 30, 45]) for (const inbound of [10, 30, 31, 61]) {
      const m = member({ budget }); const r = evaluate(event, [m], [{ ...travel, outbound: out, inbound }]);
      if (r.candidate) { expect(budget).toBeGreaterThanOrEqual(650); expect(out).toBeLessThanOrEqual(20); expect(inbound).toBeLessThanOrEqual(30); expect(Date.parse(r.candidate.members[0].returnAt)).toBeLessThanOrEqual(Date.parse(m.preferences!.availableTo)); }
    }
  });
});
describe('Цена из внешнего источника', () => {
  it.each([['650 рублей', false, 650], ['1 200 ₽', false, 1200], ['от 500 до 900 рублей', false, 900], ['', true, 0], ['от 500 рублей', false, null], ['500 ₽ + обязательный депозит', false, null], ['бесплатно для детей', false, null], ['', false, null]])('%s', (text, free, max) => expect(parsePrice(String(text), Boolean(free)).max).toBe(max));
});

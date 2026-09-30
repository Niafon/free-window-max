import { describe, it, expect } from 'vitest';
import { parseWindow, parseRequest, moscowDay } from '../packages/contracts/parse.js';
import { configureBot } from '../apps/api/src/max/bot.js';
import { readConfig } from '../apps/api/src/config.js';
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
describe('Запрос свободным текстом (без LLM)', () => {
  it('Пример из ТЗ §15', () => {
    const r = parseRequest('Сегодня после пар с девушкой на два часа, не кино, до 1000 ₽ и не дальше 30 минут', now);
    expect(r).toMatchObject({ from: '2026-09-30T17:30:00+03:00', budget: 1000, maxTravelMinutes: 30, excludedCategories: ['cinema'], partySize: 2 });
    expect(Date.parse(r.to!) - Date.parse(r.from!)).toBe(120 * 60000);
  });
  it('Диапазон часов и интересы', () => { const r = parseRequest('завтра с 19 до 22, настолки или кафе, 1500р', now); expect(r).toMatchObject({ from: '2026-10-01T19:00:00+03:00', to: '2026-10-01T22:00:00+03:00', budget: 1500, categories: ['games', 'food'] }); });
  it('«До 1000» — бюджет, а не время', () => { const r = parseRequest('вечером до 1000', now); expect(r.budget).toBe(1000); expect(r.from).toBe('2026-09-30T18:30:00+03:00'); });
  it('Бесплатно и рядом, прямо сейчас', () => { const r = parseRequest('бесплатно рядом на полтора часа', now); expect(r).toMatchObject({ budget: 0, maxTravelMinutes: 20 }); expect(Date.parse(r.to!) - Date.parse(r.from!)).toBe(90 * 60000); expect(Date.parse(r.from!)).toBeGreaterThan(now); });
  it('Тысячи и дата', () => { const r = parseRequest('02.10 18:00-21:00 до 2 тыс', now); expect(r).toMatchObject({ from: '2026-10-02T18:00:00+03:00', budget: 2000 }); });
  it('Пустой смысл — ничего не выдумывает', () => expect(parseRequest('привет', now)).toEqual({ categories: [], excludedCategories: [] }));
  it('«Без денег» не исключает следующую категорию', () => expect(parseRequest('без денег, культура', now)).toMatchObject({ budget: 0, categories: ['culture'], excludedCategories: [] }));
  it('Несколько исключений, включая еду', () => expect(parseRequest('до 500 рублей, не спорт и не еда', now)).toMatchObject({ budget: 500, categories: [], excludedCategories: expect.arrayContaining(['food', 'sport']) }));
  it('«Победа» и «среда» — не еда', () => expect(parseRequest('кино про победу', now).categories).toEqual(['cinema']));
  it('День недели — ближайший такой день', () => expect(parseRequest('в субботу с 14 до 18, спорт', now)).toMatchObject({ from: '2026-10-03T14:00:00+03:00', to: '2026-10-03T18:00:00+03:00', categories: ['sport'] }));
  it('Дорога в часах и настроение', () => expect(parseRequest('на свидание, не дальше часа', now)).toMatchObject({ maxTravelMinutes: 60, context: 'date' }));
});
describe('Настройка бота при запуске', () => {
  const config = readConfig({ BOT_TOKEN: 'unit-test-only', BOT_USERNAME: 'okno_bot', MAX_MODE: 'webhook', MAX_WEBHOOK_SECRET: 'local-test-webhook-secret-32-characters', PUBLIC_URL: 'https://okno.example.com' });
  const fake = (subs: string[], username = 'okno_bot', fail = false) => {
    const calls: string[] = [];
    const api = { setMyCommands: async (c: any[]) => { if (fail) throw Object.assign(new Error('x'), { status: 401 }); calls.push('commands:' + c.map(x => x.name).join(',')); }, getMyInfo: async () => ({ username }), getSubscriptions: async () => subs.map(url => ({ url })), subscribe: async (url: string, secret: string) => { calls.push(`subscribe:${url}:${secret.length}`); } };
    return { bot: { api } as any, calls };
  };
  const logs: Array<[string, any]> = []; const log = (level: string, data: any) => { logs.push([level, data]); };
  it('Ставит команды и подписывает webhook, если его нет', async () => { const { bot, calls } = fake([]); await configureBot(bot, config, log); expect(calls).toEqual(['commands:start,help', `subscribe:https://okno.example.com/max/webhook:${config.MAX_WEBHOOK_SECRET.length}`]); });
  it('Не трогает существующую подписку', async () => { const { bot, calls } = fake(['https://okno.example.com/max/webhook']); await configureBot(bot, config, log); expect(calls).toEqual(['commands:start,help']); });
  it('Предупреждает о несовпадении имени бота', async () => { logs.length = 0; await configureBot(fake([], 'other_bot').bot, config, log); expect(logs.some(([l, d]) => l === 'warn' && d.code === 'MAX_BOT_USERNAME_MISMATCH')).toBe(true); });
  it('Ошибка API не роняет сервер и не пишет секреты', async () => { logs.length = 0; await configureBot(fake([], 'okno_bot', true).bot, config, log); expect(logs).toEqual([['warn', { code: 'MAX_SETUP_FAILED', status: 401, apiCode: undefined }]]); });
});

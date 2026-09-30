import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrate } from '../apps/api/src/db/index.js';
import { readConfig } from '../apps/api/src/config.js';
import { buildApp } from '../apps/api/src/app.js';
import { createBot } from '../apps/api/src/max/bot.js';
import { pref, testDate } from './fixtures.js';
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('PostgreSQL/PostGIS + API + MAX', () => {
  const database = createDatabase(url || '');
  let ctx: Awaited<ReturnType<typeof buildApp>>; let alice: string, bob: string, sid: string, searchId: string, eventId: string;
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must end in _test');
    await migrate(database);
    await database.pool.query('TRUNCATE session_members,planning_sessions,searches,plans,users,events,venues,feedback,bot_dialogs,bot_updates,bot_followups,provider_quota,metrics CASCADE');
    ctx = await buildApp(readConfig({ DATABASE_URL: url, BOT_TOKEN: 'unit-test-only', MAX_WEBHOOK_SECRET: 'local-test-webhook-secret-32-characters' }), database, true);
    await ctx.app.ready();
    const login = async (name: string) => { const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/guest', payload: { name } }); expect(r.statusCode).toBe(200); return r.cookies[0].value; };
    alice = await login('Аня'); bob = await login('Борис');
  });
  afterAll(async () => { await ctx?.app.close(); await database.pool.end(); });
  const call = (method: any, url: string, payload?: any, user = alice) => ctx.app.inject({ method, url, payload, cookies: { okno_guest: user } });
  it('Состояние БД и OpenAPI доступны', async () => { expect((await call('GET', '/health')).statusCode).toBe(200); expect((await call('GET', '/openapi.json')).json().openapi).toBe('3.0.3'); });
  it('Защищает API и отвергает неверный ввод', async () => { expect((await ctx.app.inject('/api/v1/me')).statusCode).toBe(401); expect((await call('POST', '/api/v1/search', { ...pref(), budget: -1 })).statusCode).toBe(400); });
  it('Одиночный подбор → выбор → общая карточка без координат старта', async () => {
    const r = await call('POST', '/api/v1/search', pref()); expect(r.statusCode).toBe(200); expect(r.json().results.length).toBeGreaterThan(0); searchId = r.json().id; eventId = r.json().results[0].event.id;
    expect((await call('GET', `/api/v1/search/${searchId}`, undefined, bob)).statusCode).toBe(403);
    const p = await call('POST', '/api/v1/plans', { searchId, eventId }); expect(p.statusCode).toBe(201);
    const shared = await call('GET', `/api/v1/plans/${p.json().id}`, undefined, bob); expect(shared.statusCode).toBe(200); expect(shared.json().candidate.members).toEqual([]); expect(shared.json().candidate.routeUrl).not.toContain('rtext');
  });
  it('Создание компании → приглашение → параметры двух участников → общий результат', async () => {
    const notes: Array<{ ids: string[]; text: string }> = []; ctx.service.notify = async (ids, text) => { notes.push({ ids, text }); };
    const r = await call('POST', '/api/v1/sessions', { title: 'После пар', preferences: pref() }); expect(r.statusCode).toBe(201); sid = r.json().id;
    expect((await call('GET', `/api/v1/sessions/${sid}`, undefined, bob)).statusCode).toBe(403);
    expect((await call('POST', `/api/v1/sessions/${sid}/join`, undefined, bob)).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/sessions/${sid}/search`)).statusCode).toBe(409);
    expect((await call('PUT', `/api/v1/sessions/${sid}/preferences`, pref({ budget: 500, origin: { lat: 55.6637, lon: 37.4837, preset: 'southwest' } }), bob)).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/sessions/${sid}/search`, undefined, bob)).statusCode).toBe(403);
    const search = await call('POST', `/api/v1/sessions/${sid}/search`); expect(search.statusCode).toBe(200); expect(search.json().results.length).toBeGreaterThan(0);
    for (const c of search.json().results) { expect(c.totalPrice).toBeLessThanOrEqual(500); expect(c.members).toHaveLength(2); }
    const friendSearch = (await call('GET', `/api/v1/search/${search.json().id}`, undefined, bob)).json();
    expect(friendSearch.results[0].routeUrl).toContain('55.6637,37.4837~');
    expect(friendSearch.results[0].routeUrl).not.toContain('55.6706,37.4802~');
    const body = { searchId: search.json().id, eventId: search.json().results[0].event.id };
    expect((await call('POST', `/api/v1/sessions/${sid}/select`, body, bob)).statusCode).toBe(403);
    expect((await call('POST', `/api/v1/sessions/${sid}/select`, body)).statusCode).toBe(201);
    await call('PUT', `/api/v1/sessions/${sid}/preferences`, pref(), bob);
    expect((await call('POST', `/api/v1/sessions/${sid}/select`, body)).statusCode).toBe(409);
    const owner = r.json().ownerId;
    for (const [text, toOwner] of [['присоединяется', true], ['указали параметры', true], ['Общий подбор', false], ['Выбран план', false]] as const)
      expect(notes.some(n => n.text.includes(text) && (toOwner ? n.ids.includes(owner) : !n.ids.includes(owner) && n.ids.length === 1))).toBe(true);
    ctx.service.notify = async () => {};
  });
  it('Повторное присоединение идемпотентно; чужие точные параметры скрыты', async () => { const r = await call('POST', `/api/v1/sessions/${sid}/join`, undefined, bob); expect(r.json().members).toHaveLength(2); const anya = r.json().members.find((m: any) => m.name === 'Аня'); expect(anya.preferences).toBeNull(); expect(anya.window).toEqual({ from: pref().availableFrom, to: pref().availableTo }); expect(JSON.stringify(anya)).not.toContain('37.48'); });
  it('Выбор и открытие реального плана не повторяют расчёт маршрутов и не сохраняют их', async () => {
    const original = (await call('GET', `/api/v1/search/${searchId}`)).json();
    const candidate = original.results[0]; candidate.event.demo = false;
    candidate.event.provider = 'kudago'; candidate.members[0].travel.provider = 'yandex';
    const calculate = vi.spyOn(ctx.service, 'calculate').mockResolvedValueOnce({ ...original, id: randomUUID(), results: [candidate], mode: 'live' });
    try {
      const result = await call('POST', '/api/v1/search', pref({ dataMode: 'live' })); expect(result.statusCode).toBe(200);
      const pick = await call('POST', '/api/v1/plans', { searchId: result.json().id, eventId: candidate.event.id }); expect(pick.statusCode).toBe(201);
      const shared = await call('GET', `/api/v1/plans/${pick.json().id}`, undefined, bob); expect(shared.statusCode).toBe(200);
      expect(shared.json().candidate.members).toEqual([]); expect(shared.json().candidate.score).toBe(0);
      expect(calculate).toHaveBeenCalledTimes(1);
      const row = (await database.pool.query('SELECT result,selection_options FROM searches WHERE id=$1', [result.json().id])).rows[0];
      expect(row.result).toBeNull(); expect(JSON.stringify(row.selection_options)).not.toContain('outbound');
    } finally { calculate.mockRestore(); }
  });
  it('Оценка сохраняется, повторный выбор обновляет её', async () => { expect((await call('POST', `/api/v1/events/${eventId}/feedback`, { value: 1 })).statusCode).toBe(200); expect((await call('POST', `/api/v1/events/${eventId}/feedback`, { value: -1 })).statusCode).toBe(200); });
  it('Проверяет webhook secret', async () => { expect((await call('POST', '/max/webhook', { update_type: 'bot_started' })).statusCode).toBe(401); const handler = vi.fn(async () => {}); ctx.setBotHandler(handler); const r = await ctx.app.inject({ method: 'POST', url: '/max/webhook', headers: { 'x-max-bot-api-secret': 'local-test-webhook-secret-32-characters' }, payload: { update_type: 'bot_started' } }); expect(r.statusCode).toBe(200); expect(handler).toHaveBeenCalledOnce(); });
  it('Бот проходит кнопочный сценарий; повтор webhook не дублирует ответы', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(`${testDate}T10:00:00+03:00`));
    try {
    const integration = createBot(ctx.service, readConfig({ BOT_TOKEN: 'unit-test-only' })); const sent: any[] = [];
    vi.spyOn(integration.bot.api, 'sendMessageToUser').mockImplementation(async (_id, text, extra) => { sent.push({ text, extra }); return {} as any; });
    vi.spyOn(integration.bot.api, 'answerOnCallback').mockResolvedValue({ success: true } as any);
    const start = { update_type: 'bot_started', timestamp: Date.now(), user: { user_id: 456, first_name: 'Тест' } };
    await integration.process(start); const count = sent.length; await integration.process(start); expect(sent).toHaveLength(count);
    for (const payload of ['window:evening', 'budget:1000', 'origin:0', 'travel:30', 'interest:any']) await integration.process({ update_type: 'message_callback', callback: { user: start.user, callback_id: randomUUID(), payload } });
    expect(sent.some(s => s.text.startsWith('Успеешь'))).toBe(true);
    expect(sent.every(s => !s.extra || s.extra.attachments[0].payload.buttons.length > 0)).toBe(true);
    } finally { clock.mockRestore(); }
  });
  it('Бот принимает своё окно на завтра и свою сумму бюджета текстом', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(`${testDate}T10:00:00+03:00`));
    try {
    const integration = createBot(ctx.service, readConfig({ BOT_TOKEN: 'unit-test-only' })); const sent: any[] = [];
    vi.spyOn(integration.bot.api, 'sendMessageToUser').mockImplementation(async (_id, text, extra) => { sent.push({ text, extra }); return {} as any; });
    vi.spyOn(integration.bot.api, 'answerOnCallback').mockResolvedValue({ success: true } as any);
    const user = { user_id: 789, first_name: 'Текст' };
    const tap = (payload: string) => integration.process({ update_type: 'message_callback', callback: { user, callback_id: randomUUID(), payload } });
    const say = (text: string) => integration.process({ update_type: 'message_created', message: { sender: user, body: { mid: randomUUID(), text } } });
    await integration.process({ update_type: 'bot_started', timestamp: Date.now(), user });
    await tap('window:custom'); await say('в полночь'); expect(sent.at(-1).text).toContain('Не понял время');
    await say('завтра 18:30–21:30'); expect(sent.at(-1).text).toContain('Сколько готов потратить');
    await tap('budget:custom'); await say('много'); expect(sent.at(-1).text).toContain('целое число');
    await say('1500 ₽'); expect(sent.at(-1).text).toContain('Откуда выходим');
    await tap('origin:0'); await tap('travel:60'); await tap('interest:games');
    expect(sent.some(s => s.text.startsWith('Успеешь'))).toBe(true);
    expect(sent.every(s => !s.extra || s.extra.attachments[0].payload.buttons.length > 0)).toBe(true);
    } finally { clock.mockRestore(); }
  });
  it('Бот понимает запрос текстом, «Удиви меня» и спрашивает, удалось ли сходить', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(`${testDate}T10:00:00+03:00`));
    try {
    const integration = createBot(ctx.service, readConfig({ BOT_TOKEN: 'unit-test-only' })); const sent: any[] = [];
    vi.spyOn(integration.bot.api, 'sendMessageToUser').mockImplementation(async (_id, text, extra) => { sent.push({ text, extra }); return {} as any; });
    vi.spyOn(integration.bot.api, 'answerOnCallback').mockResolvedValue({ success: true } as any);
    const user = { user_id: 4242, first_name: 'Запрос' };
    const tap = (payload: string) => integration.process({ update_type: 'message_callback', callback: { user, callback_id: randomUUID(), payload } });
    const say = (text: string) => integration.process({ update_type: 'message_created', message: { sender: user, body: { mid: randomUUID(), text } } });
    await say('сегодня вечером до 1000, игры, не кино, не дальше 30 минут');
    expect(sent[0].text).toContain('Понял'); expect(sent[0].text).toContain('до 1000 ₽'); expect(sent.at(-1).text).toContain('Откуда выходим');
    await tap('origin:0');
    const card = sent.find(s => s.text.includes('🕒')); expect(card).toBeDefined();
    const pick = card.extra.attachments[0].payload.buttons[0][0].payload as string; expect(pick).toMatch(/^pick:/);
    await tap('surprise'); expect(sent.at(-2).text).toContain('🕒');
    await tap(pick);
    const row = (await ctx.service.database.pool.query('SELECT plan_id,due_at FROM bot_followups WHERE user_id=4242')).rows[0]; expect(row).toBeDefined();
    clock.mockReturnValue(Date.parse(row.due_at) + 60000);
    await ctx.service.database.pool.query("UPDATE bot_followups SET due_at=now() - interval '1 minute' WHERE user_id=4242");
    await integration.followups(); await integration.followups();
    expect(sent.filter(s => s.text.startsWith('Удалось сходить')).length).toBe(1);
    await tap(`went:${row.plan_id}:1`); expect(sent.at(-1).text).toContain('Как тебе');
    await tap(sent.at(-1).extra.attachments[0].payload.buttons[0][0].payload); expect(sent.at(-1).text).toContain('Спасибо');
    expect((await ctx.service.database.pool.query("SELECT count(*)::int AS n FROM metrics WHERE kind='outing_done'")).rows[0].n).toBe(1);
    expect(sent.every(s => !s.extra || s.extra.attachments[0].payload.buttons.length > 0)).toBe(true);
    } finally { clock.mockRestore(); }
  });
  it('Отчёт метрик §29 считает конверсию и время до результата без личных данных', async () => {
    for (const ms of [30000, 90000, 200000]) expect((await call('POST', '/api/v1/metrics', { kind: 'time_to_select', durationMs: ms })).statusCode).toBe(200);
    await call('POST', '/api/v1/metrics', { kind: 'time_to_result', durationMs: 42000 });
    const r = await ctx.app.inject('/api/v1/stats?days=7'); expect(r.statusCode).toBe(200); const st = r.json();
    expect(st.searches).toBeGreaterThan(0); expect(st.searchToSelectionPercent).toBeGreaterThan(0); expect(st.timeToResultSec.samples).toBeGreaterThan(0); expect(typeof st.timeToResultSec.median).toBe('number');
    expect(st.timeToSelectSec.samples).toBeGreaterThanOrEqual(3); expect(st.timeToSelectSec.under3MinPercent).toBeGreaterThan(0); expect(st.timeToSelectSec.under3MinPercent).toBeLessThan(100); expect(st.withinHardConstraintsPercent).toBe(100);
    expect(JSON.stringify(st)).not.toMatch(/max:|demo:|55\.6/);
    expect((await ctx.app.inject('/api/v1/stats?days=90')).statusCode).toBe(400);
  });
  it('Сбой отправки в MAX не вызывает повторных доставок, если пользователь получил ответ', async () => {
    const integration = createBot(ctx.service, readConfig({ BOT_TOKEN: 'unit-test-only' })); let calls = 0;
    vi.spyOn(integration.bot.api, 'sendMessageToUser').mockImplementation(async () => { if (++calls === 1) throw Object.assign(new Error('Bad request'), { status: 400 }); return {} as any; });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const update = { update_type: 'bot_started', timestamp: Date.now(), user: { user_id: 999, first_name: 'Сбой' } };
    await expect(integration.process(update)).resolves.toBeUndefined(); await integration.process(update);
    expect(calls).toBe(2);
  });
});

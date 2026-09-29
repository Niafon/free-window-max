import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { Service, type Identity } from '../search/service.js';
import { preferencesSchema, presets } from '../../../../packages/contracts/index.js';
import { AppError } from '../errors.js';
type State = { stage: string; from?: string; to?: string; budget?: number; origin?: number; searchId?: string };
const time = (s: string) => new Date(s).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
export function createBot(service: Service, config: Config) {
  const bot = new Bot(config.BOT_TOKEN, { clientOptions: { baseUrl: config.MAX_API_URL } });
  const cb = (text: string, payload: string) => Keyboard.button.callback(text, payload);
  const keyboard = (rows: any[][]) => ({ attachments: [Keyboard.inlineKeyboard(rows)] });
  const appButton = (payload = '') => config.BOT_USERNAME && config.PUBLIC_URL.startsWith('https://') ? [Keyboard.button.openApp('Открыть ОКНО', config.BOT_USERNAME, undefined, payload)] : [];
  const send = (id: number, text: string, rows: any[][] = []) => bot.api.sendMessageToUser(id, text, keyboard(rows.filter(r => r.length)));
  async function state(id: string): Promise<State> { return (await service.database.pool.query('SELECT state FROM bot_dialogs WHERE user_id=$1', [id])).rows[0]?.state ?? { stage: 'start' }; }
  async function save(id: string, value: State) { await service.database.pool.query('INSERT INTO bot_dialogs(user_id,state) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()', [id, JSON.stringify(value)]); }
  async function start(id: number, u: Identity) {
    await save(u.id, { stage: 'window' });
    await send(id, 'ОКНО — досуг, который помещается в твоё время.\n\nВыбери свободное окно. Я проверю бюджет и дорогу туда и обратно.\n\nВ чате работает учебный набор Москвы: события и время пути демонстрационные. Реальные события доступны в мини-приложении.', [[cb('На 2 часа', 'window:120'), cb('На 3 часа', 'window:180')], [cb('Сегодня 18:30–21:30', 'window:evening')], [cb('Другое время', 'window:custom')], appButton()]);
  }
  async function process(update: any) {
    const person = update.user ?? update.callback?.user ?? update.message?.sender;
    const id = person?.user_id;
    if (!Number.isSafeInteger(id) || person?.is_bot) return;
    const u = { id: `max:${id}`, name: String(person.first_name ?? person.name ?? 'Участник').slice(0, 60), maxId: id };
    const eventKey = update.callback?.callback_id ?? update.message?.body?.mid ?? createHash('sha256').update(JSON.stringify(update)).digest('hex');
    const reserved = await service.database.pool.query("INSERT INTO bot_updates(id,expires_at) VALUES($1,now()+interval '24 hours') ON CONFLICT DO NOTHING RETURNING id", [eventKey]);
    if (!reserved.rows.length) return;
    try {
      await service.user(u);
      const payload: string = update.callback?.payload ?? '';
      if (update.callback?.callback_id) await bot.api.answerOnCallback(update.callback.callback_id, {}).catch(() => {});
      const text = update.message?.body?.text ?? '';
      if (update.update_type === 'bot_started' || /^\/start\b/.test(text) || payload === 'restart') { await start(id, u); return; }
      if (text === '/help') { await send(id, 'Нажми /start для нового подбора. Время — московское.\nВ мини-приложении можно создать компанию, пригласить друзей и задать индивидуальные ограничения.', [appButton()]); return; }
      const s = await state(u.id);
      if (payload.startsWith('window:')) {
        const v = payload.split(':')[1]; const now = new Date(Math.ceil((Date.now() + 60000) / 60000) * 60000);
        if (v === 'custom') { await save(u.id, { stage: 'custom' }); await send(id, 'Напиши окно в формате 18:30–21:30 (сегодня, московское время). Или начни заново: /start'); return; }
        if (!['120', '180', 'evening'].includes(v)) return;
        const day = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
        const from = v === 'evening' ? `${day}T18:30:00+03:00` : now.toISOString();
        const to = v === 'evening' ? `${day}T21:30:00+03:00` : new Date(now.getTime() + Number(v) * 60000).toISOString();
        if (Date.parse(from) < Date.now()) { await send(id, 'Это время уже прошло. Выбери окно «На 2 часа» или укажи другое время.', [[cb('На 2 часа', 'window:120')]]); return; }
        await save(u.id, { stage: 'budget', from, to }); await send(id, 'Сколько готов потратить? В чат-сценарии считаем, что проезд покрыт проездным. Другие расходы на дорогу можно задать в мини-приложении.', [[cb('Бесплатно', 'budget:0'), cb('До 500 ₽', 'budget:500')], [cb('До 1000 ₽', 'budget:1000'), cb('До 2000 ₽', 'budget:2000')]]); return;
      }
      if (s.stage === 'custom' && text) {
        const match = text.match(/^(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})$/);
        if (!match) { await send(id, 'Нужен формат 18:30–21:30. Попробуй ещё раз.'); return; }
        const day = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10), from = `${day}T${match[1]}:00+03:00`, to = `${day}T${match[2]}:00+03:00`;
        if (!Number.isFinite(Date.parse(from)) || Date.parse(from) < Date.now() || Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 12 * 3600000) { await send(id, 'Проверь время: начало должно быть в будущем, окно — до 12 часов.'); return; }
        await save(u.id, { stage: 'budget', from, to }); await send(id, 'Выбери бюджет. Проезд считаем по проездному.', [[cb('Бесплатно', 'budget:0'), cb('500 ₽', 'budget:500'), cb('1000 ₽', 'budget:1000')]]); return;
      }
      if (payload.startsWith('budget:') && s.from && s.to) {
        const budget = Number(payload.split(':')[1]); if (![0, 500, 1000, 2000].includes(budget)) return;
        await save(u.id, { ...s, stage: 'origin', budget }); await send(id, 'Откуда выходим? Для демонстрации выбери точку из списка.', presets.map((p, i) => [cb(p.label, `origin:${i}`)])); return;
      }
      if (payload.startsWith('origin:') && s.budget !== undefined) {
        const origin = Number(payload.split(':')[1]); if (!presets[origin]) return;
        await save(u.id, { ...s, stage: 'travel', origin }); await send(id, 'Сколько минут готов ехать в одну сторону?', [[cb('20 минут', 'travel:20'), cb('30 минут', 'travel:30'), cb('45 минут', 'travel:45')]]); return;
      }
      if (payload.startsWith('travel:') && s.origin !== undefined) {
        const maxTravelMinutes = Number(payload.split(':')[1]); if (![20, 30, 45].includes(maxTravelMinutes)) return;
        const p = presets[s.origin];
        const preferences = preferencesSchema.parse({ availableFrom: s.from, availableTo: s.to, budget: s.budget, maxTravelMinutes, origin: { ...p, preset: p.id }, dataMode: 'demo' });
        await send(id, 'Проверяю события, бюджет и возвращение…');
        const result = await service.search(u, preferences); await save(u.id, { ...s, stage: 'results', searchId: result.id });
        if (!result.results.length) { await send(id, 'Подходящих вариантов нет.\n' + result.compromises.map(c => `${c.label} → ${c.count} вариантов`).join('\n') + '\n' + result.notices.join('\n'), [[cb('Изменить условия', 'restart')], appButton()]); return; }
        await send(id, `В твоё окно помещается ${result.results.length} вариантов. Ниже лучшие. События и дорога — демонстрационные.`, [appButton(`search_${result.id}`)]);
        for (const r of result.results.slice(0, 5)) await send(id, `${r.event.title}\n${time(r.startAt)}–${time(r.endAt)} · ${r.totalPrice} ₽\nДорога: ${r.members[0].travel.outbound} мин · возврат ${time(r.members[0].returnAt)}\n${r.reasons.join('\n')}\nМодельные данные, реальной записи нет.`, [[cb('Выбрать план', `pick:${result.id}:${r.event.id}`)]]);
        await send(id, 'Можно начать новый подбор:', [[cb('Найти ещё', 'restart')]]); return;
      }
      if (payload.startsWith('pick:')) {
        const [, searchId, eventId] = payload.split(':'); if (!/^[\da-f-]{36}$/.test(searchId ?? '') || !eventId) return;
        const plan = await service.select(u, searchId, eventId);
        await send(id, `План сохранён: ${plan.candidate.event.title}\n${time(plan.candidate.startAt)}–${time(plan.candidate.endAt)}\nДемонстрационный план. Перед реальным выходом проверь место и расписание.`, [[Keyboard.button.link('Открыть Яндекс Карты', plan.candidate.routeUrl)], [Keyboard.button.link('Позвать друга', `https://max.ru/:share?text=${encodeURIComponent('Пойдём вместе! ' + plan.shareUrl)}`)], appButton(`plan_${plan.id}`), [cb('Новый подбор', 'restart')]]); return;
      }
      await send(id, 'Продолжи с кнопок в последнем сообщении или начни новый подбор: /start', [appButton()]);
    } catch (error) {
      // Release failed deliveries so MAX can retry; never log raw updates or credentials.
      await service.database.pool.query('DELETE FROM bot_updates WHERE id=$1', [eventKey]);
      if (error instanceof AppError) { await send(id, error.message, [[cb('Изменить условия', 'restart')]]); return; }
      throw error;
    }
  }
  bot.on(['bot_started', 'message_created', 'message_callback'], ctx => process(ctx.update));
  return { bot, process };
}


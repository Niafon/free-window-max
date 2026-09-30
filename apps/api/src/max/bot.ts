import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { Service, type Identity } from '../search/service.js';
import { preferencesSchema, presets, categoryNames } from '../../../../packages/contracts/index.js';
import { AppError } from '../errors.js';
type Geo = { lat: number; lon: number };
type State = { stage: string; from?: string; to?: string; budget?: number; origin?: number; geo?: Geo; searchId?: string };
const time = (s: string) => new Date(s).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const dayLabel = (s: string) => new Date(s).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
// Moscow calendar day shifted by `offset` days, as YYYY-MM-DD.
export const moscowDay = (offset = 0, now = Date.now()) => new Date(now + 3 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
// "18:30–21:30", "завтра 18:30-21:30", "02.10 18:30–21:30" → ISO window in Moscow time.
export function parseWindow(text: string, now = Date.now()): { from: string; to: string } | null {
  const m = text.trim().toLowerCase().match(/^(?:(сегодня|завтра|послезавтра|\d{1,2}\.\d{1,2})\s+)?(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/);
  if (!m) return null;
  let day = moscowDay(0, now);
  if (m[1] === 'завтра') day = moscowDay(1, now); else if (m[1] === 'послезавтра') day = moscowDay(2, now);
  else if (m[1]?.includes('.')) {
    const [d, mo] = m[1].split('.').map(Number), year = Number(day.slice(0, 4));
    day = `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (day < moscowDay(0, now)) day = `${year + 1}${day.slice(4)}`;
  }
  const pad = (t: string) => t.padStart(5, '0');
  const from = `${day}T${pad(m[2])}:00+03:00`; let to = `${day}T${pad(m[3])}:00+03:00`;
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) return null;
  // An overnight window such as 22:00–01:00 ends on the next day.
  if (Date.parse(to) <= Date.parse(from)) to = new Date(Date.parse(to) + 86400000).toISOString();
  return { from, to };
}
export function createBot(service: Service, config: Config) {
  const bot = new Bot(config.BOT_TOKEN, { clientOptions: { baseUrl: config.MAX_API_URL } });
  const live = !!config.YANDEX_MAPS_KEY;
  const cb = (text: string, payload: string) => Keyboard.button.callback(text, payload);
  const keyboard = (rows: any[][]) => ({ attachments: [Keyboard.inlineKeyboard(rows)] });
  const appButton = (payload = '') => config.BOT_USERNAME && config.PUBLIC_URL.startsWith('https://') ? [Keyboard.button.openApp('Открыть ОКНО', config.BOT_USERNAME, undefined, payload)] : [];
  // MAX rejects an inline keyboard without buttons, so plain messages go without attachments.
  const send = (id: number, text: string, rows: any[][] = []) => { const filled = rows.filter(r => r.length); return bot.api.sendMessageToUser(id, text, filled.length ? keyboard(filled) : undefined); };
  // Group session events are delivered to MAX members only; demo users have no chat.
  service.notify = async (userIds, text, sessionId) => {
    for (const uid of userIds) { const n = Number(/^max:(\d+)$/.exec(uid)?.[1]); if (Number.isSafeInteger(n)) await send(n, text, [appButton(`session_${sessionId}`)]).catch(() => {}); }
  };
  async function state(id: string): Promise<State> { return (await service.database.pool.query('SELECT state FROM bot_dialogs WHERE user_id=$1', [id])).rows[0]?.state ?? { stage: 'start' }; }
  async function save(id: string, value: State) { await service.database.pool.query('INSERT INTO bot_dialogs(user_id,state) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()', [id, JSON.stringify(value)]); }
  const windowRows = () => [[cb('Прямо сейчас · 2 ч', 'window:120'), cb('На 3 часа', 'window:180')], [cb('Сегодня вечером', 'window:evening'), cb('Завтра вечером', 'window:tomorrow')], [cb('Другое время', 'window:custom')], appButton()];
  async function start(id: number, u: Identity) {
    await save(u.id, { stage: 'window' });
    await send(id, `ОКНО — досуг, который помещается в твоё время.\n\nВыбери свободное окно. Я проверю бюджет и дорогу туда и обратно и покажу только то, что реально успеть.\n\n${live ? 'Отправь геопозицию — посчитаю реальные события Москвы и маршруты. Точки из списка работают на учебном наборе.' : 'В чате работает учебный набор Москвы: события и время пути демонстрационные.'}`, windowRows());
  }
  async function askBudget(id: number, u: Identity, s: State) {
    await save(u.id, { ...s, stage: 'budget' });
    await send(id, `Окно: ${dayLabel(s.from!)}, ${time(s.from!)}–${time(s.to!)}.\nСколько готов потратить на человека? Проезд считаем по проездному.`, [[cb('Бесплатно', 'budget:0'), cb('До 500 ₽', 'budget:500')], [cb('До 1000 ₽', 'budget:1000'), cb('До 2000 ₽', 'budget:2000')], [cb('Своя сумма', 'budget:custom')]]);
  }
  async function askOrigin(id: number, u: Identity, s: State) {
    await save(u.id, { ...s, stage: 'origin' });
    await send(id, live ? 'Откуда выходим? Отправь геопозицию или выбери точку из списка.' : 'Откуда выходим? Для демонстрации выбери точку из списка.', [...(live ? [[Keyboard.button.requestGeoLocation('📍 Отправить геопозицию')]] : []), ...presets.map((p, i) => [cb(p.label, `origin:${i}`)])]);
  }
  async function askTravel(id: number, u: Identity, s: State) {
    await save(u.id, { ...s, stage: 'travel' });
    await send(id, 'Сколько минут готов ехать в одну сторону?', [[cb('20 минут', 'travel:20'), cb('30 минут', 'travel:30')], [cb('45 минут', 'travel:45'), cb('60 минут', 'travel:60')]]);
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
      const text: string = (update.message?.body?.text ?? '').trim();
      const location = (update.message?.body?.attachments ?? []).find((a: any) => a?.type === 'location');
      if (update.update_type === 'bot_started' || /^\/start\b/.test(text) || payload === 'restart') { await start(id, u); return; }
      if (text === '/help') { await send(id, 'Нажми /start для нового подбора. Время — московское.\nСвоё окно можно написать текстом: «18:30–21:30», «завтра 19:00–22:00» или «02.10 18:00–21:00».\nВ мини-приложении можно создать компанию, пригласить друзей и задать индивидуальные ограничения.', [appButton()]); return; }
      const s = await state(u.id);
      if (payload.startsWith('window:')) {
        const v = payload.split(':')[1]; const now = new Date(Math.ceil((Date.now() + 60000) / 60000) * 60000);
        if (v === 'custom') { await save(u.id, { stage: 'custom' }); await send(id, 'Напиши окно, московское время:\n• 18:30–21:30 — сегодня\n• завтра 19:00–22:00\n• 02.10 18:00–21:00 — в ближайшие 7 дней'); return; }
        if (!['120', '180', 'evening', 'tomorrow'].includes(v)) return;
        const day = moscowDay(v === 'tomorrow' ? 1 : 0);
        const evening = v === 'evening' || v === 'tomorrow';
        const from = evening ? `${day}T18:30:00+03:00` : now.toISOString();
        const to = evening ? `${day}T21:30:00+03:00` : new Date(now.getTime() + Number(v) * 60000).toISOString();
        if (Date.parse(from) < Date.now()) { await send(id, 'Сегодняшний вечер уже начался. Выбери «Прямо сейчас», «Завтра вечером» или своё время.', [[cb('Прямо сейчас · 2 ч', 'window:120'), cb('Завтра вечером', 'window:tomorrow')], [cb('Другое время', 'window:custom')]]); return; }
        await askBudget(id, u, { stage: 'budget', from, to }); return;
      }
      if (s.stage === 'custom' && text) {
        const w = parseWindow(text);
        if (!w) { await send(id, 'Не понял время. Пример: 18:30–21:30 или завтра 19:00–22:00.'); return; }
        const days = (Date.parse(w.from.slice(0, 10)) - Date.parse(moscowDay())) / 86400000;
        if (Date.parse(w.from) < Date.now() || days > 7 || Date.parse(w.to) - Date.parse(w.from) > 12 * 3600000) { await send(id, 'Проверь время: начало в будущем, не дальше 7 дней, окно — до 12 часов.'); return; }
        await askBudget(id, u, { stage: 'budget', ...w }); return;
      }
      if (payload.startsWith('budget:') && s.from && s.to) {
        const v = payload.split(':')[1];
        if (v === 'custom') { await save(u.id, { ...s, stage: 'budget_custom' }); await send(id, 'Напиши сумму на человека в рублях, например 1500.'); return; }
        const budget = Number(v); if (![0, 500, 1000, 2000].includes(budget)) return;
        await askOrigin(id, u, { ...s, budget }); return;
      }
      if (s.stage === 'budget_custom' && s.from && s.to && text) {
        const budget = Number(text.replace(/[\s₽р.руб]/gi, ''));
        if (!Number.isInteger(budget) || budget < 0 || budget > 50000) { await send(id, 'Нужно целое число от 0 до 50 000, например 1500.'); return; }
        await askOrigin(id, u, { ...s, budget }); return;
      }
      if (s.stage === 'origin' && s.budget !== undefined && (payload.startsWith('origin:') || location)) {
        if (location) {
          const geo = { lat: Number(location.latitude), lon: Number(location.longitude) };
          if (!live) { await send(id, 'Реальные маршруты ещё не подключены. Выбери точку из списка.', presets.map((p, i) => [cb(p.label, `origin:${i}`)])); return; }
          if (!(geo.lat >= 55.1 && geo.lat <= 56.2 && geo.lon >= 36.5 && geo.lon <= 38.5)) { await send(id, 'Пока ищу только по Москве. Выбери точку из списка или отправь геопозицию в Москве.', presets.map((p, i) => [cb(p.label, `origin:${i}`)])); return; }
          await askTravel(id, u, { ...s, geo, origin: undefined }); return;
        }
        const origin = Number(payload.split(':')[1]); if (!presets[origin]) return;
        await askTravel(id, u, { ...s, origin, geo: undefined }); return;
      }
      if (payload.startsWith('travel:') && (s.origin !== undefined || s.geo)) {
        const maxTravelMinutes = Number(payload.split(':')[1]); if (![20, 30, 45, 60].includes(maxTravelMinutes)) return;
        const p = s.geo ? undefined : presets[s.origin!];
        const origin = s.geo ? { ...s.geo, label: 'Моя геопозиция' } : { lat: p!.lat, lon: p!.lon, label: p!.label, preset: p!.id };
        const preferences = preferencesSchema.parse({ availableFrom: s.from, availableTo: s.to, budget: s.budget, maxTravelMinutes, origin, dataMode: s.geo ? 'live' : 'demo' });
        await send(id, s.geo ? 'Ищу события Москвы и считаю маршруты туда и обратно…' : 'Проверяю события, бюджет и возвращение…');
        const result = await service.search(u, preferences); await save(u.id, { ...s, stage: 'results', searchId: result.id });
        const demo = result.mode === 'demo';
        if (!result.results.length) { await send(id, 'В это окно ничего не помещается.\n' + (result.compromises.length ? 'Что поможет:\n' + result.compromises.map(c => `• ${c.label} → ${c.count} вар.`).join('\n') : '') + (result.notices.length ? '\n\n' + result.notices.join('\n') : ''), [[cb('Изменить условия', 'restart')], appButton()]); return; }
        await send(id, `Успеешь ${result.results.length} вар. Ниже лучшие${demo ? ' (учебный набор: события и дорога демонстрационные)' : ''}.`, [appButton(`search_${result.id}`)]);
        for (const r of result.results.slice(0, 5)) {
          const m = r.members[0], cats = r.event.categories.map(c => categoryNames[c] ?? c).join(', ');
          await send(id, `${r.event.title}\n${r.event.venue}${r.event.address ? ' · ' + r.event.address : ''}\n🕒 ${time(r.startAt)}–${time(r.endAt)} · ${r.totalPrice ? r.totalPrice + ' ₽' : 'бесплатно'}${cats ? ' · ' + cats : ''}\n🚇 ${m.travel.outbound} мин туда · вернёшься к ${time(m.returnAt)} · запас ${m.spareMinutes} мин\n${r.reasons.map(x => '✓ ' + x).join('\n')}${r.warnings.length ? '\n⚠️ ' + r.warnings.join('\n⚠️ ') : ''}`,
            [[cb('Иду', `pick:${result.id}:${r.event.id}`), Keyboard.button.link('Маршрут', r.routeUrl)], r.sourceUrl ? [Keyboard.button.link('Источник', r.sourceUrl)] : []]);
        }
        await send(id, 'Не то? Можно поменять условия:', [[cb('Новый подбор', 'restart')]]); return;
      }
      if (payload.startsWith('pick:')) {
        const [, searchId, eventId] = payload.split(':'); if (!/^[\da-f-]{36}$/.test(searchId ?? '') || !eventId) return;
        const plan = await service.select(u, searchId, eventId);
        await send(id, `План сохранён: ${plan.candidate.event.title}\n${dayLabel(plan.candidate.startAt)}, ${time(plan.candidate.startAt)}–${time(plan.candidate.endAt)}\n${plan.candidate.event.demo ? 'Демонстрационный план. ' : ''}Перед выходом проверь место и расписание.`, [[Keyboard.button.link('Открыть Яндекс Карты', plan.candidate.routeUrl)], [Keyboard.button.link('Позвать друга', `https://max.ru/:share?text=${encodeURIComponent('Пойдём вместе! ' + plan.shareUrl)}`)], appButton(`plan_${plan.id}`), [cb('Новый подбор', 'restart')]]); return;
      }
      await send(id, 'Продолжи с кнопок в последнем сообщении или начни новый подбор: /start', [[cb('Новый подбор', 'restart')], appButton()]);
    } catch (error) {
      if (error instanceof AppError) {
        await service.database.pool.query('DELETE FROM bot_updates WHERE id=$1', [eventKey]);
        await send(id, error.message, [[cb('Изменить условия', 'restart')]]); return;
      }
      const e = error as { status?: number; code?: string; message?: string };
      console.error(JSON.stringify({ level: 50, code: 'MAX_BOT_ERROR', stage: update.update_type, status: e?.status, apiCode: e?.code, message: String(e?.message ?? error).slice(0, 200) }));
      // Tell the user and keep the update reserved: a MAX retry would fail the same way.
      try { await send(id, 'Не получилось обработать нажатие. Начни заново — данные не потеряются.', [[cb('Новый подбор', 'restart')]]); return; } catch {}
      // Release failed deliveries so MAX can retry; never log raw updates or credentials.
      await service.database.pool.query('DELETE FROM bot_updates WHERE id=$1', [eventKey]);
      throw error;
    }
  }
  bot.on(['bot_started', 'message_created', 'message_callback'], ctx => process(ctx.update));
  return { bot, process };
}

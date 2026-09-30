import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { Service, type Identity } from '../search/service.js';
import { preferencesSchema, presets, categoryNames, categories } from '../../../../packages/contracts/index.js';
import { AppError } from '../errors.js';
import { moscowDay, parseRequest, parseWindow } from '../../../../packages/contracts/parse.js';
type Category = typeof categories[number];
type Geo = { lat: number; lon: number };
type Start = { origin?: number; geo?: Geo };
type State = { stage: string; from?: string; to?: string; budget?: number; origin?: number; geo?: Geo; travel?: number; categories?: Category[]; excluded?: Category[]; surprise?: boolean; searchId?: string; last?: Start };
const time = (s: string) => new Date(s).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const dayLabel = (s: string) => new Date(s).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
const interestButtons: Category[] = ['games', 'culture', 'food', 'music', 'walk', 'sport'];
export function createBot(service: Service, config: Config) {
  const bot = new Bot(config.BOT_TOKEN, { clientOptions: { baseUrl: config.MAX_API_URL } });
  const live = !!config.YANDEX_MAPS_KEY;
  const cb = (text: string, payload: string) => Keyboard.button.callback(text, payload);
  const appButton = (payload = '') => config.BOT_USERNAME && config.PUBLIC_URL.startsWith('https://') ? [Keyboard.button.openApp('Открыть ОКНО', config.BOT_USERNAME, undefined, payload)] : [];
  // MAX rejects an inline keyboard without buttons, so plain messages go without attachments.
  // A photo is optional: if MAX cannot fetch it, the card is sent again without it.
  const send = async (id: number, text: string, rows: any[][] = [], image?: string | null): Promise<unknown> => {
    const filled = rows.filter(r => r.length), attachments: any[] = [...(image ? [{ type: 'image', payload: { url: image } }] : []), ...(filled.length ? [Keyboard.inlineKeyboard(filled)] : [])];
    try { return await bot.api.sendMessageToUser(id, text, attachments.length ? { attachments } : undefined); } catch (error) { if (!image) throw error; return send(id, text, rows); }
  };
  // Group session events are delivered to MAX members only; demo users have no chat.
  service.notify = async (userIds, text, sessionId) => {
    for (const uid of userIds) { const n = Number(/^max:(\d+)$/.exec(uid)?.[1]); if (Number.isSafeInteger(n)) await send(n, text, [appButton(`session_${sessionId}`)]).catch(() => {}); }
  };
  async function state(id: string): Promise<State> { return (await service.database.pool.query('SELECT state FROM bot_dialogs WHERE user_id=$1', [id])).rows[0]?.state ?? { stage: 'start' }; }
  async function save(id: string, value: State) { await service.database.pool.query('INSERT INTO bot_dialogs(user_id,state) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()', [id, JSON.stringify(value)]); }
  const nextMinute = () => new Date(Math.ceil((Date.now() + 60000) / 60000) * 60000);
  const windowRows = () => [[cb('Прямо сейчас · 2 ч', 'window:120'), cb('На 3 часа', 'window:180')], [cb('Сегодня вечером', 'window:evening'), cb('Завтра вечером', 'window:tomorrow')], [cb('Другое время', 'window:custom'), cb('🎲 Удиви меня', 'surprise')], appButton()];
  const originRows = () => [...(live ? [[Keyboard.button.requestGeoLocation('📍 Отправить геопозицию')]] : []), ...presets.map((p, i) => [cb(p.label, `origin:${i}`)])];
  // A new request asks everything again; the last start point is remembered only for "Удиви меня".
  const fresh = (s: State): State => ({ stage: 'window', last: s.geo || s.origin !== undefined ? { origin: s.origin, geo: s.geo } : s.last });
  async function start(id: number, u: Identity, s: State) {
    await save(u.id, fresh(s));
    await send(id, `ОКНО — досуг, который помещается в твоё время.\n\nНапиши запрос как другу, например:\n«сегодня после пар на 2 часа до 1000, не кино, не дальше 30 минут»\n— или выбери окно кнопками. Я проверю бюджет и дорогу туда и обратно и покажу только то, что реально успеть.\n\n${live ? 'С геопозицией считаю реальные события Москвы и маршруты. Точки из списка работают на учебном наборе.' : 'В чате работает учебный набор Москвы: события и время пути демонстрационные.'}`, windowRows());
  }
  // Asks for the first missing parameter; once everything is known, runs the search.
  async function advance(id: number, u: Identity, s: State) {
    if (!s.from || !s.to) { await save(u.id, { ...s, stage: 'window' }); await send(id, 'Когда ты свободен?', windowRows()); return; }
    if (s.budget === undefined) { await save(u.id, { ...s, stage: 'budget' }); await send(id, `Окно: ${dayLabel(s.from)}, ${time(s.from)}–${time(s.to)}.\nСколько готов потратить на человека? Проезд считаем по проездному.`, [[cb('Бесплатно', 'budget:0'), cb('До 500 ₽', 'budget:500')], [cb('До 1000 ₽', 'budget:1000'), cb('До 2000 ₽', 'budget:2000')], [cb('Своя сумма', 'budget:custom')]]); return; }
    if (s.origin === undefined && !s.geo) { await save(u.id, { ...s, stage: 'origin' }); await send(id, live ? 'Откуда выходим? Отправь геопозицию или выбери точку из списка.' : 'Откуда выходим? Для демонстрации выбери точку из списка.', originRows()); return; }
    if (s.travel === undefined) { await save(u.id, { ...s, stage: 'travel' }); await send(id, 'Сколько минут готов ехать в одну сторону?', [[cb('20 минут', 'travel:20'), cb('30 минут', 'travel:30')], [cb('45 минут', 'travel:45'), cb('60 минут', 'travel:60')]]); return; }
    if (!s.categories) { await save(u.id, { ...s, stage: 'interests' }); await send(id, 'Что по душе? Подниму такие варианты выше.', [interestButtons.slice(0, 3).map(c => cb(categoryNames[c], `interest:${c}`)), interestButtons.slice(3).map(c => cb(categoryNames[c], `interest:${c}`)), [cb('Без разницы', 'interest:any')]]); return; }
    await search(id, u, s);
  }
  function summary(s: State) {
    const parts = [s.from && s.to ? `${dayLabel(s.from)}, ${time(s.from)}–${time(s.to)}` : '', s.budget !== undefined ? (s.budget ? `до ${s.budget} ₽` : 'бесплатно') : '', s.travel ? `дорога до ${s.travel} мин` : '',
      s.categories?.length ? s.categories.map(c => categoryNames[c]).join(', ') : '', s.excluded?.length ? 'без: ' + s.excluded.map(c => categoryNames[c].toLowerCase()).join(', ') : ''];
    return parts.filter(Boolean).join(' · ');
  }
  async function search(id: number, u: Identity, s: State) {
    const p = s.geo ? undefined : presets[s.origin!];
    const origin = s.geo ? { ...s.geo, label: 'Моя геопозиция' } : { lat: p!.lat, lon: p!.lon, label: p!.label, preset: p!.id };
    const preferences = preferencesSchema.parse({ availableFrom: s.from, availableTo: s.to, budget: s.budget, maxTravelMinutes: s.travel, origin, categories: s.categories ?? [], excludedCategories: s.excluded ?? [], dataMode: s.geo ? 'live' : 'demo' });
    await send(id, s.geo ? 'Ищу события Москвы и считаю маршруты туда и обратно…' : 'Проверяю события, бюджет и возвращение…');
    const result = await service.search(u, preferences); await save(u.id, { ...s, stage: 'results', searchId: result.id });
    const demo = result.mode === 'demo';
    if (!result.results.length) { await send(id, 'В это окно ничего не помещается.\n' + (result.compromises.length ? 'Что поможет:\n' + result.compromises.map(c => `• ${c.label} → ${c.count} вар.`).join('\n') : '') + (result.notices.length ? '\n\n' + result.notices.join('\n') : ''), [[cb('Изменить условия', 'restart')], appButton()]); return; }
    // "Surprise me" picks one of the three best instead of listing them.
    const shown = s.surprise ? [result.results[Math.floor(Math.random() * Math.min(3, result.results.length))]] : result.results.slice(0, 5);
    await send(id, s.surprise ? `🎲 Вот что успеешь${demo ? ' (учебный набор)' : ''}:` : `Успеешь ${result.results.length} вар. Ниже лучшие${demo ? ' (учебный набор: события и дорога демонстрационные)' : ''}.`, [appButton(`search_${result.id}`)]);
    for (const r of shown) {
      const m = r.members[0], cats = r.event.categories.map(c => categoryNames[c] ?? c).join(', ');
      await send(id, `${r.event.title}\n${r.event.venue}${r.event.address ? ' · ' + r.event.address : ''}\n🕒 ${time(r.startAt)}–${time(r.endAt)} · ${r.totalPrice ? r.totalPrice + ' ₽' : 'бесплатно'}${cats ? ' · ' + cats : ''}\n🚇 ${m.travel.outbound} мин туда · вернёшься к ${time(m.returnAt)} · запас ${m.spareMinutes} мин\n${r.reasons.map(x => '✓ ' + x).join('\n')}${r.warnings.length ? '\n⚠️ ' + r.warnings.join('\n⚠️ ') : ''}`,
        [[cb('Иду', `pick:${result.id}:${r.event.id}`), Keyboard.button.link('Маршрут', r.routeUrl)], r.sourceUrl ? [Keyboard.button.link('Источник', r.sourceUrl)] : []], r.event.imageUrl);
    }
    await send(id, s.surprise ? 'Не то?' : 'Не то? Можно поменять условия:', [...(s.surprise ? [[cb('🎲 Ещё вариант', 'surprise')]] : []), [cb('Новый подбор', 'restart')]]);
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
      const s = await state(u.id);
      if (update.update_type === 'bot_started' || /^\/start\b/.test(text) || payload === 'restart') { await start(id, u, s); return; }
      if (text === '/help') { await send(id, 'Напиши запрос текстом: «завтра вечером до 1500, игры или еда, 30 минут» — или нажми /start и выбери кнопками. Время — московское.\nСвоё окно: «18:30–21:30», «завтра 19:00–22:00», «02.10 18:00–21:00».\nВ мини-приложении можно создать компанию, пригласить друзей и задать каждому свои ограничения.', [appButton()]); return; }
      if (payload === 'surprise') {
        const from = nextMinute();
        const f = fresh(s);
        await advance(id, u, { ...f, ...f.last, from: from.toISOString(), to: new Date(from.getTime() + 120 * 60000).toISOString(), budget: 1000, travel: 30, categories: [], surprise: true }); return;
      }
      if (payload.startsWith('window:')) {
        const v = payload.split(':')[1];
        if (v === 'custom') { await save(u.id, { ...s, stage: 'custom' }); await send(id, 'Напиши окно, московское время:\n• 18:30–21:30 — сегодня\n• завтра 19:00–22:00\n• 02.10 18:00–21:00 — в ближайшие 7 дней'); return; }
        if (!['120', '180', 'evening', 'tomorrow'].includes(v)) return;
        const day = moscowDay(v === 'tomorrow' ? 1 : 0), evening = v === 'evening' || v === 'tomorrow', now = nextMinute();
        const from = evening ? `${day}T18:30:00+03:00` : now.toISOString();
        const to = evening ? `${day}T21:30:00+03:00` : new Date(now.getTime() + Number(v) * 60000).toISOString();
        if (Date.parse(from) < Date.now()) { await send(id, 'Сегодняшний вечер уже начался. Выбери «Прямо сейчас», «Завтра вечером» или своё время.', [[cb('Прямо сейчас · 2 ч', 'window:120'), cb('Завтра вечером', 'window:tomorrow')], [cb('Другое время', 'window:custom')]]); return; }
        await advance(id, u, { ...fresh(s), from, to }); return;
      }
      if (s.stage === 'custom' && text) {
        const w = parseWindow(text);
        if (!w) { await send(id, 'Не понял время. Пример: 18:30–21:30 или завтра 19:00–22:00.'); return; }
        if (!validWindow(w)) { await send(id, 'Проверь время: начало в будущем, не дальше 7 дней, окно — до 12 часов.'); return; }
        await advance(id, u, { ...fresh(s), ...w }); return;
      }
      if (payload.startsWith('budget:') && s.from && s.to) {
        const v = payload.split(':')[1];
        if (v === 'custom') { await save(u.id, { ...s, stage: 'budget_custom' }); await send(id, 'Напиши сумму на человека в рублях, например 1500.'); return; }
        const budget = Number(v); if (![0, 500, 1000, 2000].includes(budget)) return;
        await advance(id, u, { ...s, budget }); return;
      }
      if (s.stage === 'budget_custom' && s.from && s.to && text) {
        const budget = Number(text.replace(/[\s₽р.руб]/gi, ''));
        if (!Number.isInteger(budget) || budget < 0 || budget > 50000) { await send(id, 'Нужно целое число от 0 до 50 000, например 1500.'); return; }
        await advance(id, u, { ...s, budget }); return;
      }
      if (location && s.stage === 'origin') {
        const geo = { lat: Number(location.latitude), lon: Number(location.longitude) };
        if (!live) { await send(id, 'Реальные маршруты ещё не подключены. Выбери точку из списка.', originRows()); return; }
        if (!(geo.lat >= 55.1 && geo.lat <= 56.2 && geo.lon >= 36.5 && geo.lon <= 38.5)) { await send(id, 'Пока ищу только по Москве. Выбери точку из списка или отправь геопозицию в Москве.', originRows()); return; }
        await advance(id, u, { ...s, geo, origin: undefined }); return;
      }
      if (payload.startsWith('origin:') && s.stage === 'origin') {
        const origin = Number(payload.split(':')[1]); if (!presets[origin]) return;
        await advance(id, u, { ...s, origin, geo: undefined }); return;
      }
      if (payload.startsWith('travel:') && s.stage === 'travel') {
        const travel = Number(payload.split(':')[1]); if (![20, 30, 45, 60].includes(travel)) return;
        await advance(id, u, { ...s, travel }); return;
      }
      if (payload.startsWith('interest:') && s.stage === 'interests') {
        const v = payload.split(':')[1] as Category | 'any'; if (v !== 'any' && !interestButtons.includes(v)) return;
        await advance(id, u, { ...s, categories: v === 'any' ? [] : [v] }); return;
      }
      if (payload.startsWith('pick:')) {
        const [, searchId, eventId] = payload.split(':'); if (!/^[\da-f-]{36}$/.test(searchId ?? '') || !eventId) return;
        const plan = await service.select(u, searchId, eventId);
        // Ask about the outing two hours after it ends: the "Выход состоялся" pilot metric.
        await service.database.pool.query('INSERT INTO bot_followups(plan_id,user_id,event_id,title,due_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [plan.id, id, eventId, plan.candidate.event.title, new Date(Date.parse(plan.candidate.endAt) + 2 * 3600000)]);
        await send(id, `План сохранён: ${plan.candidate.event.title}\n${dayLabel(plan.candidate.startAt)}, ${time(plan.candidate.startAt)}–${time(plan.candidate.endAt)}\n${plan.candidate.event.demo ? 'Демонстрационный план. ' : ''}Перед выходом проверь место и расписание. После события спрошу, как всё прошло.`, [[Keyboard.button.link('Открыть Яндекс Карты', plan.candidate.routeUrl)], [Keyboard.button.link('Позвать друга', `https://max.ru/:share?text=${encodeURIComponent('Пойдём вместе! ' + plan.shareUrl)}`)], appButton(`plan_${plan.id}`), [cb('Новый подбор', 'restart')]]); return;
      }
      if (payload.startsWith('went:')) {
        const [, planId, value] = payload.split(':');
        const row = (await service.database.pool.query('UPDATE bot_followups SET answer=$3 WHERE plan_id=$1 AND user_id=$2 AND answer IS NULL RETURNING event_id,title', [planId, id, value === '1'])).rows[0];
        if (!row) return;
        await service.database.pool.query('INSERT INTO metrics(kind) VALUES($1)', [value === '1' ? 'outing_done' : 'outing_missed']);
        if (value === '1') await send(id, `Здорово! Как тебе «${row.title}»?`, [[cb('👍 Понравилось', `rate:${row.event_id}:1`), cb('👎 Не очень', `rate:${row.event_id}:-1`)]]);
        else await send(id, 'Жаль. Подберём что-нибудь на следующее окно?', [[cb('Новый подбор', 'restart')]]);
        return;
      }
      if (payload.startsWith('rate:')) {
        const [, eventId, value] = payload.split(':'); if (!eventId || !['1', '-1'].includes(value)) return;
        await service.rate(u, eventId, Number(value)); await send(id, 'Спасибо! Учту в следующих подборах.', [[cb('Новый подбор', 'restart')]]); return;
      }
      if (text && !['custom', 'budget_custom'].includes(s.stage)) {
        const q = parseRequest(text);
        if (q.from || q.budget !== undefined || q.maxTravelMinutes || q.categories.length || q.excludedCategories.length) {
          if (q.from && !validWindow({ from: q.from, to: q.to! })) { await send(id, 'Время должно быть в будущем, не дальше 7 дней, окно — до 12 часов. Попробуй ещё раз или выбери кнопками.', windowRows()); return; }
          const next: State = { ...fresh(s), from: q.from, to: q.to, budget: q.budget, travel: q.maxTravelMinutes, excluded: q.excludedCategories, categories: q.categories.length || q.excludedCategories.length ? q.categories : undefined };
          await send(id, `Понял: ${summary(next) || 'уточню детали'}.${q.partySize ? '\nДля компании с разными окнами и бюджетами открой mini app — там можно пригласить друга.' : ''}`);
          await advance(id, u, next); return;
        }
        await send(id, 'Не понял запрос. Пример: «сегодня вечером до 1000, игры, не дальше 30 минут». Или выбери кнопками:', windowRows()); return;
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
  function validWindow(w: { from: string; to: string }) {
    const days = (Date.parse(new Date(Date.parse(w.from) + 3 * 3600000).toISOString().slice(0, 10)) - Date.parse(moscowDay())) / 86400000;
    return Date.parse(w.from) >= Date.now() - 60000 && days <= 7 && Date.parse(w.to) > Date.parse(w.from) && Date.parse(w.to) - Date.parse(w.from) <= 12 * 3600000;
  }
  // Sends due "did you go?" questions; claimed atomically so parallel runs never double-send.
  async function followups() {
    const due = await service.database.pool.query('UPDATE bot_followups SET sent_at=now() WHERE plan_id IN (SELECT plan_id FROM bot_followups WHERE sent_at IS NULL AND due_at <= now() LIMIT 20) RETURNING plan_id,user_id,title');
    for (const f of due.rows) await send(Number(f.user_id), `Удалось сходить на «${f.title}»?`, [[cb('Да, сходил(а)', `went:${f.plan_id}:1`), cb('Не получилось', `went:${f.plan_id}:0`)]]).catch(() => {});
  }
  bot.on(['bot_started', 'message_created', 'message_callback'], ctx => process(ctx.update));
  return { bot, process, followups };
}

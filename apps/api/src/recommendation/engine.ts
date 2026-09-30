import { randomUUID } from 'node:crypto';
import type { Candidate, Event, Member, Preferences, SearchResult, Travel } from '../../../../packages/contracts/index.js';
import { categoryNames } from '../../../../packages/contracts/index.js';
import { weights, BUFFER_MINUTES } from '../../../../packages/config/index.js';
import type { RouteProvider } from '../providers/index.js';
import { AppError } from '../errors.js';
const minute = 60000;
const iso = (n: number) => new Date(n).toISOString();
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export function commonWindow(members: Member[]) {
  const ready = members.map(m => m.preferences!);
  const from = Math.max(...ready.map(p => Date.parse(p.availableFrom))), to = Math.min(...ready.map(p => Date.parse(p.availableTo)));
  return { from, to };
}
export function evaluate(event: Event, members: Member[], routes: Travel[]): { candidate?: Candidate; reasons: string[] } {
  const reasons = new Set<string>();
  if (!event.priceKnown || event.priceMax === null) reasons.add('Цена не подтверждена');
  if (event.availability === 'sold_out') reasons.add('Нет свободных мест');
  if (!Number.isFinite(Date.parse(event.startAt)) || !Number.isFinite(Date.parse(event.endAt)) || Date.parse(event.endAt) <= Date.parse(event.startAt)) reasons.add('Нет точного расписания');
  const arrival = members.map((m, i) => Date.parse(m.preferences!.availableFrom) + (routes[i].outbound + BUFFER_MINUTES) * minute);
  const start = event.flexible ? Math.max(Date.parse(event.startAt), ...arrival) : Date.parse(event.startAt);
  const end = event.flexible ? start + event.durationMinutes * minute : Date.parse(event.endAt);
  if (end > Date.parse(event.endAt)) reasons.add('Не хватает времени до закрытия');
  members.forEach((m, i) => {
    const p = m.preferences!, r = routes[i];
    if (p.age < event.ageRestriction) reasons.add('Возрастное ограничение');
    if (event.categories.some(c => p.excludedCategories.includes(c as any))) reasons.add('Исключённая категория');
    if ((event.priceMax ?? Infinity) + p.transportBudget > p.budget) reasons.add('Выше бюджета');
    if (r.outbound > p.maxTravelMinutes || r.inbound > p.maxTravelMinutes) reasons.add('Дорога дольше лимита');
    if (arrival[i] > start || end + (r.inbound + BUFFER_MINUTES) * minute > Date.parse(p.availableTo)) reasons.add('Не помещается в окно с возвращением');
  });
  if (reasons.size) return { reasons: [...reasons] };
  const moods: Record<string, string[]> = { calm: ['culture', 'walk', 'food'], active: ['sport', 'games'], date: ['culture', 'food', 'music'], any: [] };
  const interests = members.map(m => { const p = m.preferences!; const tag = p.categories.length ? event.categories.filter(c => p.categories.includes(c as any)).length / p.categories.length : 0.5; return p.context === 'any' ? tag : 0.8 * tag + 0.2 * Number(event.categories.some(c => moods[p.context].includes(c))); });
  const average = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;
  const interestScore = 0.7 * average(interests) + 0.3 * Math.min(...interests);
  const travelScores = members.map((m, i) => 1 - Math.max(routes[i].outbound, routes[i].inbound) / m.preferences!.maxTravelMinutes);
  const travelScore = 0.7 * average(travelScores) + 0.3 * Math.min(...travelScores);
  const priceScore = Math.min(...members.map(m => m.preferences!.budget === 0 ? 1 : 1 - ((event.priceMax ?? 0) + m.preferences!.transportBudget) / m.preferences!.budget));
  const timeScore = Math.min(...members.map((m, i) => clamp((Date.parse(m.preferences!.availableTo) - end - (routes[i].inbound + BUFFER_MINUTES) * minute) / (30 * minute))));
  const qualityScore = event.availability === 'available' ? 1 : 0.5;
  const score = Math.round(1000 * (weights.interest * interestScore + weights.travel * travelScore + weights.price * priceScore + weights.time * timeScore + weights.quality * qualityScore)) / 1000;
  const p = members[0].preferences!;
  const matched = event.categories.filter(c => members.some(m => m.preferences!.categories.includes(c as any)));
  const candidate: Candidate = {
    event, score, startAt: iso(start), endAt: iso(end), totalPrice: Math.max(...members.map(m => (event.priceMax ?? 0) + m.preferences!.transportBudget)),
    reasons: [`Укладывается в окно ${members.length > 1 ? 'каждого участника' : 'с возвращением'}`, `В пределах бюджета${members.length > 1 ? ' каждого' : ''}`, ...matched.map(c => `Совпадает с интересом «${categoryNames[c] ?? c}»`)],
    members: members.map((m, i) => ({ name: m.name, travel: routes[i], arriveAt: iso(Date.parse(m.preferences!.availableFrom) + routes[i].outbound * minute), returnAt: iso(end + (routes[i].inbound + BUFFER_MINUTES) * minute), spareMinutes: Math.floor((Date.parse(m.preferences!.availableTo) - end) / minute) - routes[i].inbound - BUFFER_MINUTES })),
    routeUrl: `https://yandex.ru/maps/?rtext=${members.length === 1 ? `${p.origin.lat},${p.origin.lon}` : ''}~${event.latitude},${event.longitude}&rtt=mt`, sourceUrl: event.sourceUrl,
    warnings: [...(event.estimate === 'end' ? [`Окончание источник не указал — считаем ${event.durationMinutes} мин, это оценка`] : []), ...(event.estimate === 'hours' ? [`Свободное посещение ~${event.durationMinutes} мин в часы работы площадки (по данным KudaGo) — проверьте их перед выходом`] : []), ...(event.availability === 'unknown' ? ['Наличие мест не подтверждено — уточните у организатора'] : []), ...(routes.some(r => r.modelled) ? ['Время в пути — модельное, не реальный маршрут'] : []), ...(members.some(m => m.preferences!.transportBudget === 0) ? ['Проезд: 0 ₽ по введённым параметрам (например, по проездному)'] : [])],
  };
  return { candidate, reasons: [] };
}
export async function recommend(events: Event[], members: Member[], provider: RouteProvider, notices: string[] = []): Promise<SearchResult> {
  if (!members.length || members.some(m => !m.preferences)) throw new AppError('INVALID_INPUT', 'Каждый участник должен указать свои параметры');
  const window = commonWindow(members);
  const base: SearchResult = { id: randomUUID(), results: [], excluded: [], compromises: [], commonWindow: window.from < window.to ? { from: iso(window.from), to: iso(window.to) } : null, mode: events.some(e => e.demo) ? 'demo' : 'live', notices, createdAt: new Date().toISOString() };
  if (window.from >= window.to) {
    const gap = Math.ceil((window.from - window.to) / minute) + 60;
    base.notices.push(`Общего окна нет. Для совместного часа нужно расширить самое раннее окончание минимум на ${gap} мин. Затем повторите подбор с дорогой.`);
    return base;
  }
  const evaluated: Array<{ event: Event; routes: Travel[] }> = [];
  let failures = 0;
  // Bounded candidate set and concurrency keep external calls controlled.
  const selected = [...events].sort((a, b) => Number(b.priceKnown) - Number(a.priceKnown) || a.id.localeCompare(b.id)).slice(0, 20);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (next < selected.length) {
      const event = selected[next++];
      if (!event.priceKnown || event.priceMax === null || event.availability === 'sold_out') {
        base.excluded.push({ id: event.id, title: event.title, reasons: [!event.priceKnown ? 'Цена не подтверждена' : 'Нет свободных мест'] }); continue;
      }
      try {
        let routes = await Promise.all(members.map(m => provider.getRoute(m.preferences!.origin, event, m.preferences!.availableFrom, event.endAt)));
        if (event.flexible && routes.some(r => !r.modelled)) {
          const start = Math.max(Date.parse(event.startAt), ...members.map((m, i) => Date.parse(m.preferences!.availableFrom) + (routes[i].outbound + BUFFER_MINUTES) * minute));
          routes = await Promise.all(members.map(m => provider.getRoute(m.preferences!.origin, event, m.preferences!.availableFrom, iso(start + event.durationMinutes * minute))));
        }
        evaluated.push({ event, routes }); const result = evaluate(event, members, routes);
        if (result.candidate) base.results.push(result.candidate); else base.excluded.push({ id: event.id, title: event.title, reasons: result.reasons });
      } catch (error) {
        failures++; base.excluded.push({ id: event.id, title: event.title, reasons: [error instanceof AppError ? error.message : 'Маршрут не проверен'] });
      }
    }
  }));
  if (failures && evaluated.length === 0) throw new AppError('ROUTE_PROVIDER_ERROR', 'Не удалось проверить маршруты. В деморежиме используйте точку старта из списка; для реальных маршрутов проверьте подключение Яндекса.', 503, true);
  if (failures) base.notices.push(`${failures} вариантов скрыто: маршрут не удалось проверить.`);
  base.results.sort((a, b) => b.score - a.score || a.event.id.localeCompare(b.event.id)); base.results = base.results.slice(0, 10);
  base.excluded.sort((a, b) => a.id.localeCompare(b.id));
  if (!base.results.length && evaluated.length) {
    const rules = [
      { field: 'maxTravelMinutes', values: [5, 10, 15, 20, 30, 45], label: (v: number) => `На ${v} мин больше на дорогу` },
      { field: 'budget', values: [100, 200, 300, 500, 1000], label: (v: number) => `Бюджет каждого +${v} ₽` },
      { field: 'availableTo', values: [15, 30, 45, 60, 90], label: (v: number) => `Вернуться на ${v} мин позже` },
    ];
    for (const rule of rules) for (const value of rule.values) {
      const relaxed = members.map(m => { const p = { ...m.preferences! }; if (rule.field === 'availableTo') p.availableTo = iso(Date.parse(p.availableTo) + value * minute); else if (rule.field === 'budget') p.budget += value; else p.maxTravelMinutes += value; return { ...m, preferences: p }; });
      const count = evaluated.filter(({ event, routes }) => evaluate(event, relaxed, routes).candidate).length;
      if (count) { base.compromises.push({ field: rule.field, value, count, label: rule.label(value) }); break; }
    }
  }
  return base;
}

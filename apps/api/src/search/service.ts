import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { searches, users, planningSessions, sessionMembers, plans, feedback } from '../db/schema.js';
import type { Config } from '../config.js';
import type { Event, Member, Preferences, Candidate, SearchResult } from '../../../../packages/contracts/index.js';
import { DemoEventProvider, DemoRouteProvider } from '../providers/demo.js';
import { KudaGoProvider } from '../providers/kudago.js';
import { YandexRouteProvider } from '../providers/yandex.js';
import { recommend } from '../recommendation/engine.js';
import { AppError } from '../errors.js';
export type Identity = { id: string; name: string; maxId?: number };
export class Service {
  demo = new DemoEventProvider(); live = new KudaGoProvider(); demoRoute = new DemoRouteProvider(); yandex: YandexRouteProvider;
  constructor(public database: Database, public config: Config) {
    this.yandex = new YandexRouteProvider(config.YANDEX_MAPS_KEY, async () => {
      const r = await database.pool.query(`INSERT INTO provider_quota(day,used) VALUES ((now() AT TIME ZONE 'Europe/Moscow')::date,1) ON CONFLICT(day) DO UPDATE SET used=provider_quota.used+1 WHERE provider_quota.used < $1 RETURNING used`, [config.YANDEX_DAILY_LIMIT]);
      if (!r.rows.length || config.YANDEX_DAILY_LIMIT === 0) throw new AppError('RATE_LIMITED', 'Дневной лимит маршрутов исчерпан. Демо остаётся доступно.', 429);
    });
  }
  // Set by the MAX bot; group events reach members in chat. Delivery failures never break the API call.
  notify: (userIds: string[], text: string, sessionId: string) => Promise<void> = async () => {};
  announce(userIds: string[], text: string, sessionId: string) { if (userIds.length) void this.notify(userIds, text, sessionId).catch(() => {}); }
  get db() { return this.database.db; }
  ownRoute(result: SearchResult, p: Preferences): SearchResult {
    return { ...result, results: result.results.map(c => ({ ...c, routeUrl: `https://yandex.ru/maps/?rtext=${p.origin.lat},${p.origin.lon}~${c.event.latitude},${c.event.longitude}&rtt=mt` })) };
  }
  shareCard(c: Candidate): Candidate {
    // Retain source event fields only: no Yandex durations, ranking or origin.
    return { event: c.event, score: 0, startAt: c.event.demo ? c.startAt : c.event.startAt, endAt: c.event.demo ? c.endAt : c.event.endAt,
      totalPrice: c.event.priceMax ?? 0, members: [], routeUrl: `https://yandex.ru/maps/?pt=${c.event.longitude},${c.event.latitude}&z=16&l=map`, sourceUrl: c.sourceUrl,
      reasons: ['План по ссылке. Постройте маршрут от своей точки в Яндекс Картах.'], warnings: ['Цена события без личных расходов на дорогу. Перед выходом проверьте расписание и наличие мест.'] };
  }
  async user(u: Identity) { return (await this.db.insert(users).values({ id: u.id, name: u.name }).onConflictDoUpdate({ target: users.id, set: { name: u.name, lastSeen: new Date() } }).returning())[0]; }
  validateDates(p: Preferences) {
    const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
    const day = new Date(Date.parse(p.availableFrom) + 3 * 3600000).toISOString().slice(0, 10);
    const days = (Date.parse(day) - Date.parse(today)) / 86400000;
    if (days < 0 || days > 7) throw new AppError('INVALID_INPUT', 'Выберите сегодня или дату в ближайшие 7 дней');
    if (Date.parse(p.availableFrom) < Date.now() - 60000) throw new AppError('INVALID_INPUT', 'Начало окна уже прошло. Выберите более позднее время');
  }
  async calculate(members: Member[]) {
    members.forEach(m => this.validateDates(m.preferences!));
    const mode = members[0].preferences!.dataMode;
    if (members.some(m => m.preferences!.dataMode !== mode)) throw new AppError('INVALID_INPUT', 'Все участники должны выбрать один режим данных');
    if (mode === 'live' && !this.config.YANDEX_MAPS_KEY) throw new AppError('ROUTE_PROVIDER_ERROR', 'Реальные маршруты ещё не подключены', 503);
    const { events, notices } = await (mode === 'demo' ? this.demo : this.live).searchEvents(members[0].preferences!);
    // Geographic filtering is just a shortlist, never an estimate of travel duration.
    for (const e of events) {
      await this.database.pool.query(`INSERT INTO venues(id,name,location) VALUES($1,$2,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,location=EXCLUDED.location`, [e.venueId, e.venue, e.longitude, e.latitude]);
      await this.database.pool.query(`INSERT INTO events(id,venue_id,payload) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`, [e.id, e.venueId, JSON.stringify(e)]);
    }
    // Shortlist around the group's centre: nearest venues first, so the route quota goes to the most promising events.
    const lon = members.reduce((s, m) => s + m.preferences!.origin.lon, 0) / members.length, lat = members.reduce((s, m) => s + m.preferences!.origin.lat, 0) / members.length;
    const ids = events.map(e => e.id);
    const rows = ids.length ? await this.database.pool.query(`SELECT e.payload FROM events e JOIN venues v ON e.venue_id=v.id WHERE e.id=ANY($1) AND ST_DWithin(v.location,ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,60000) ORDER BY ST_Distance(v.location,ST_SetSRID(ST_MakePoint($2,$3),4326)::geography), e.id`, [ids, lon, lat]) : { rows: [] };
    let candidates = rows.rows.map(r => r.payload as Event);
    if (mode === 'live') {
      candidates = candidates.filter(e => e.priceKnown && e.priceMax !== null && members.every(m => e.priceMax! + m.preferences!.transportBudget <= m.preferences!.budget && e.ageRestriction <= m.preferences!.age && !e.categories.some(c => m.preferences!.excludedCategories.includes(c as any)) && Date.parse(e.startAt) >= Date.parse(m.preferences!.availableFrom) && Date.parse(e.endAt) <= Date.parse(m.preferences!.availableTo))).slice(0, this.config.LIVE_CANDIDATES);
      notices.push(`Реальный поиск проверяет ${candidates.length} ближайших подходящих событий: до ${candidates.length * 2} запросов к Яндексу на человека, повторные маршруты берутся из кэша. Дневной предел — ${this.config.YANDEX_DAILY_LIMIT}.`);
    }
    return recommend(candidates, members, mode === 'demo' ? this.demoRoute : this.yandex, notices);
  }
  async search(u: Identity, p: Preferences, sessionId?: string, members?: Member[]) {
    const start = Date.now(); const result = await this.calculate(members ?? [{ userId: u.id, name: u.name, preferences: p }]);
    // Persist source-only choices; selecting/sharing never spends another route request.
    await this.db.insert(searches).values({ id: result.id, userId: u.id, sessionId, preferences: p, result: p.dataMode === 'demo' ? result : null, selectionOptions: result.results.map(c => this.shareCard(c)), expiresAt: new Date(Date.now() + 86400000) });
    await this.database.pool.query('INSERT INTO metrics(kind,duration_ms,result_count) VALUES($1,$2,$3)', [sessionId ? 'group_search' : 'search', Date.now() - start, result.results.length]);
    return this.ownRoute(result, members?.find(m => m.userId === u.id)?.preferences ?? p);
  }
  async getSearch(id: string, u: Identity, publicPlan = false) {
    const row = (await this.db.select().from(searches).where(eq(searches.id, id)))[0];
    if (!row || row.expiresAt.getTime() < Date.now()) throw new AppError('SEARCH_NOT_FOUND', 'Подбор устарел. Найдите варианты снова', 404);
    if (!publicPlan && row.userId !== u.id) {
      if (!row.sessionId) throw new AppError('FORBIDDEN', 'Этот подбор принадлежит другому пользователю', 403);
      await this.session(row.sessionId, u);
    }
    if (row.result) {
      if (row.sessionId && !publicPlan) {
        const session = await this.session(row.sessionId, u);
        if (session.searchId !== id) throw new AppError('SESSION_CHANGED', 'Параметры компании изменились. Повторите общий подбор', 409);
        return this.ownRoute(row.result, session.members.find(m => m.userId === u.id)!.preferences!);
      }
      return row.result;
    }
    throw new AppError('SEARCH_EXPIRED', 'Реальные маршруты не сохраняются. Запустите новый подбор явно; сохранённая карточка плана доступна по ссылке.', 409);
  }
  async createSession(u: Identity, title: string, preferences?: Preferences) {
    const id = randomUUID();
    await this.db.transaction(async tx => {
      await tx.insert(planningSessions).values({ id, ownerId: u.id, title, expiresAt: new Date(Date.now() + 86400000) });
      await tx.insert(sessionMembers).values({ sessionId: id, userId: u.id, name: u.name, preferences });
    });
    return this.session(id, u);
  }
  async session(id: string, u: Identity, invitePreview = false) {
    const session = (await this.db.select().from(planningSessions).where(eq(planningSessions.id, id)))[0];
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'План не найден. Проверьте ссылку приглашения', 404);
    if (session.expiresAt.getTime() < Date.now()) throw new AppError('SESSION_EXPIRED', 'Плану больше 24 часов. Создайте новый', 410);
    const members = await this.db.select().from(sessionMembers).where(eq(sessionMembers.sessionId, id));
    if (!invitePreview && !members.some(m => m.userId === u.id)) throw new AppError('FORBIDDEN', 'Сначала присоединитесь к компании', 403);
    return { ...session, members, inviteUrl: this.config.BOT_USERNAME && this.config.PUBLIC_URL.startsWith('https://') ? `https://max.ru/${this.config.BOT_USERNAME}?startapp=session_${id}` : `${this.config.PUBLIC_URL}/?session=${id}` };
  }
  async join(id: string, u: Identity) {
    await this.session(id, u, true); let joined = false;
    await this.db.transaction(async tx => {
      await tx.execute((await import('drizzle-orm')).sql`SELECT id FROM planning_sessions WHERE id=${id} FOR UPDATE`);
      const members = await tx.select().from(sessionMembers).where(eq(sessionMembers.sessionId, id));
      if (members.some(m => m.userId === u.id)) return;
      if (members.length >= 5) throw new AppError('GROUP_FULL', 'В компании уже пять человек', 409);
      await tx.insert(sessionMembers).values({ sessionId: id, userId: u.id, name: u.name });
      await tx.update(planningSessions).set({ searchId: null, selectedId: null, revision: (await this.session(id, u, true)).revision + 1 }).where(eq(planningSessions.id, id));
      joined = true;
    });
    const s = await this.session(id, u);
    if (joined) this.announce([s.ownerId], `${u.name} присоединяется к «${s.title}». В компании ${s.members.length} из 5.`, id);
    return s;
  }
  async preferences(id: string, u: Identity, p: Preferences) {
    this.validateDates(p); await this.session(id, u);
    await this.db.transaction(async tx => {
      const { sql } = await import('drizzle-orm');
      await tx.execute(sql`SELECT id FROM planning_sessions WHERE id=${id} FOR UPDATE`);
      await tx.update(sessionMembers).set({ preferences: p }).where(and(eq(sessionMembers.sessionId, id), eq(sessionMembers.userId, u.id)));
      await tx.execute(sql`UPDATE planning_sessions SET search_id=NULL,selected_id=NULL,revision=revision+1 WHERE id=${id}`);
    });
    const s = await this.session(id, u);
    if (u.id === s.ownerId) { /* the owner sees the group state in the app */ }
    else if (s.members.length > 1 && s.members.every(m => m.preferences)) this.announce([s.ownerId], `Все участники «${s.title}» (${s.members.length}) указали параметры. Можно запускать общий подбор.`, id);
    else this.announce([s.ownerId], `${u.name} обновляет свои параметры в «${s.title}». Ждём остальных.`, id);
    return s;
  }
  async groupSearch(id: string, u: Identity) {
    const s = await this.session(id, u);
    if (s.ownerId !== u.id) throw new AppError('FORBIDDEN', 'Общий подбор запускает создатель компании', 403);
    if (s.members.some(m => !m.preferences)) throw new AppError('GROUP_NOT_READY', 'Дождитесь параметров всех участников', 409);
    const result = await this.search(u, s.members[0].preferences!, id, s.members);
    const changed = await this.db.update(planningSessions).set({ searchId: result.id, selectedId: null }).where(and(eq(planningSessions.id, id), eq(planningSessions.revision, s.revision))).returning();
    if (!changed.length) throw new AppError('SESSION_CHANGED', 'Кто-то изменил параметры. Повторите общий подбор', 409);
    this.announce(s.members.filter(m => m.userId !== u.id).map(m => m.userId), result.results.length ? `Общий подбор «${s.title}» готов: ${result.results.length} вар., которые подходят каждому.` : `Для «${s.title}» общих вариантов нет. Создатель предложит изменить условия.`, id);
    return result;
  }
  async select(u: Identity, searchId: string, eventId: string, sessionId?: string) {
    const row = (await this.db.select().from(searches).where(eq(searches.id, searchId)))[0];
    if (!row || row.expiresAt.getTime() < Date.now()) throw new AppError('SEARCH_NOT_FOUND', 'Подбор устарел. Найдите варианты снова', 404);
    if (row.userId !== u.id) {
      if (!row.sessionId) throw new AppError('FORBIDDEN', 'Этот подбор принадлежит другому пользователю', 403);
      await this.session(row.sessionId, u);
    }
    if ((row.sessionId ?? undefined) !== sessionId) throw new AppError('INVALID_INPUT', 'Выбирайте общий вариант из своей компании');
    const candidate = (row.result?.results ?? row.selectionOptions ?? []).find(r => r.event.id === eventId);
    if (!candidate) throw new AppError('INVALID_INPUT', 'Вариант отсутствует в этом подборе');
    if (sessionId) {
      const s = await this.session(sessionId, u);
      if (s.ownerId !== u.id) throw new AppError('FORBIDDEN', 'Общий вариант выбирает создатель компании', 403);
      const updated = await this.db.update(planningSessions).set({ selectedId: eventId }).where(and(eq(planningSessions.id, sessionId), eq(planningSessions.searchId, searchId))).returning();
      if (!updated.length) throw new AppError('SESSION_CHANGED', 'Параметры изменились, повторите подбор', 409);
      const when = new Date(candidate.startAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
      this.announce(s.members.filter(m => m.userId !== u.id).map(m => m.userId), `Выбран план «${s.title}»: ${candidate.event.title}, ${when}. ${candidate.event.address || candidate.event.venue}`, sessionId);
    }
    const id = randomUUID(); await this.db.insert(plans).values({ id, userId: u.id, searchId, eventId, snapshot: this.shareCard(candidate) });
    await this.database.pool.query('INSERT INTO metrics(kind) VALUES($1)', ['selection']);
    return { id, candidate, shareUrl: this.config.BOT_USERNAME && this.config.PUBLIC_URL.startsWith('https://') ? `https://max.ru/${this.config.BOT_USERNAME}?startapp=plan_${id}` : `${this.config.PUBLIC_URL}/?plan=${id}` };
  }
  async getPlan(id: string, u: Identity) {
    const row = (await this.db.select().from(plans).where(eq(plans.id, id)))[0];
    if (!row || Date.now() - row.createdAt.getTime() > 86400000) throw new AppError('PLAN_NOT_FOUND', 'План не найден или устарел', 404);
    if (row.snapshot) return { id, candidate: row.snapshot };
    const search = await this.getSearch(row.searchId, u, true);
    const c = search.results.find(c => c.event.id === row.eventId);
    if (!c) throw new AppError('NO_RESULTS', 'Вариант больше не проходит ограничения. Повторите поиск', 409);
    // A shared card never discloses participants, origins or personal constraints.
    return { id, candidate: { ...c, members: [], routeUrl: `https://yandex.ru/maps/?pt=${c.event.longitude},${c.event.latitude}&z=16&l=map` } };
  }
  async rate(u: Identity, eventId: string, value: number) {
    await this.db.insert(feedback).values({ userId: u.id, eventId, value }).onConflictDoUpdate({ target: [feedback.userId, feedback.eventId], set: { value, updatedAt: new Date() } });
    return { ok: true };
  }
}

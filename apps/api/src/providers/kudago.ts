import type { Event, Preferences } from '../../../../packages/contracts/index.js';
import type { EventProvider } from './index.js';
import { providerJson } from './http.js';

// Only unambiguous, mandatory RUB prices can pass a hard budget constraint.
export function parsePrice(value: string, free: boolean): { min: number | null; max: number | null } {
  if (free) return { min: 0, max: 0 };
  const s = value.toLowerCase().replace(/[\u00a0\u202f]/g, ' ').replace(/,?\s*есть льготы\.?$/, '').trim();
  const exact = s.match(/^(\d[\d ]*)\s*(?:руб(?:лей|ля|ль|\.)?|₽)\.?$/);
  if (exact) { const n = Number(exact[1].replace(/ /g, '')); return { min: n, max: n }; }
  const range = s.match(/^(?:от\s*)?(\d[\d ]*)\s*(?:до|–|-)\s*(\d[\d ]*)\s*(?:руб(?:лей|ля|ль|\.)?|₽)\.?$/);
  if (range) return { min: Number(range[1].replace(/ /g, '')), max: Number(range[2].replace(/ /g, '')) };
  return { min: null, max: null };
}
const mapping: Record<string, string> = { exhibition: 'culture', theater: 'culture', concert: 'music', cinema: 'cinema', recreation: 'walk', 'games-and-quests': 'games', sport: 'sport', 'entertainment': 'games', 'festival': 'culture' };
const FRESH = 10 * 60000, STALE = 3 * 3600000, PAGES = 5;
const WEEK = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
// Opening hours for one weekday (0 = Monday) from KudaGo text like "пн–пт 12:00–22:00, сб, вс 10:00–22:00".
export function openingHours(timetable: string, weekday: number): { open: string; close: string } | null {
  const text = timetable.toLowerCase().replace(/[\u00a0\u202f]/g, ' ').replace(/—/g, '–');
  if (/круглосуточно/.test(text) && !/\d{1,2}:\d{2}/.test(text)) return { open: '00:00', close: '23:59' };
  let days = new Set<number>();
  for (const part of text.split(/[,;]|\bи\b/)) {
    if (/ежедневно|каждый день|без выходных/.test(part)) WEEK.forEach((_, i) => days.add(i));
    for (const m of part.matchAll(/(пн|вт|ср|чт|пт|сб|вс)(?:\s*[–-]\s*(пн|вт|ср|чт|пт|сб|вс))?/g)) {
      const a = WEEK.indexOf(m[1]), b = m[2] ? WEEK.indexOf(m[2]) : a;
      for (let i = a; ; i = (i + 1) % 7) { days.add(i); if (i === b) break; }
    }
    const t = part.match(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/);
    if (t) {
      if (days.has(weekday)) {
        const open = `${t[1].padStart(2, '0')}:${t[2]}`, close = t[3] === '24' || t[3] === '00' ? '23:59' : `${t[3].padStart(2, '0')}:${t[4]}`;
        return close > open ? { open, close } : null;
      }
      days = new Set();
    }
  }
  return null;
}
// Typical length when the source gives only a start time; always shown as an estimate.
const TYPICAL: Record<string, number> = { concert: 120, theater: 150, education: 90, lecture: 90, 'stand-up': 90, show: 90, kids: 90, quest: 60, party: 180, festival: 180 };
const typicalMinutes = (cats: string[]) => Math.max(...cats.map(c => TYPICAL[c] ?? 0), 0) || 120;
// Visit length for exhibitions and museums (TZ §9: recommended minimum visit).
const VISIT_MINUTES = 60;
const NOT_A_VISIT = ['stock', 'shopping', 'business-events', 'yarmarki-razvlecheniya-yarmarki'];
// KudaGo answers in 3–5 s (14 s with expanded dates), so events are loaded per Moscow day, cached and pre-warmed; a search only filters them.
export class KudaGoProvider implements EventProvider {
  private days = new Map<string, { at: number; rows: any[] }>();
  private timetables = new Map<number, string>();
  private loading = new Map<string, Promise<any[]>>();
  private events = new Map<string, Event>();
  private page(day: string, page: number) {
    const since = Date.parse(`${day}T00:00:00+03:00`) / 1000;
    const url = new URL('https://kudago.com/public-api/v1.4/events/');
    Object.entries({ location: 'msk', page_size: '100', page: String(page), actual_since: String(since), actual_until: String(since + 86400), expand: 'place', fields: 'id,title,description,categories,tags,age_restriction,dates,price,is_free,place,site_url,publication_date,images', text_format: 'text' }).forEach(([k, v]) => url.searchParams.set(k, v));
    return providerJson(url, 'EVENT', 1, 10000);
  }
  rows(day: string): Promise<any[]> {
    const cached = this.days.get(day);
    if (cached && Date.now() - cached.at < FRESH) return Promise.resolve(cached.rows);
    const running = this.loading.get(day); if (running) return running;
    const load = (async () => {
      const first = await this.page(day, 1);
      const pages = Math.min(PAGES, Math.ceil((first.count ?? 0) / 100));
      const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => this.page(day, i + 2).then(b => b.results ?? []).catch(() => [])));
      const rows = [...(first.results ?? []), ...rest.flat()];
      await this.loadTimetables(rows.map(r => r.place?.id).filter((id): id is number => Number.isInteger(id) && !this.timetables.has(id)));
      this.days.set(day, { at: Date.now(), rows }); if (this.days.size > 10) this.days.delete(this.days.keys().next().value!);
      return rows;
    })().finally(() => this.loading.delete(day));
    this.loading.set(day, load); return load;
  }
  // Opening hours live on places, not events; one request per 100 places, failures just mean no free visits.
  private async loadTimetables(ids: number[]) {
    const unique = [...new Set(ids)];
    await Promise.all(Array.from({ length: Math.ceil(unique.length / 100) }, async (_, i) => {
      const url = new URL('https://kudago.com/public-api/v1.4/places/');
      Object.entries({ ids: unique.slice(i * 100, i * 100 + 100).join(','), fields: 'id,timetable,is_closed', page_size: '100', text_format: 'text' }).forEach(([k, v]) => url.searchParams.set(k, v));
      const body = await providerJson(url, 'EVENT', 1, 10000).catch(() => ({ results: [] }));
      for (const p of body.results ?? []) this.timetables.set(p.id, p.is_closed ? '' : String(p.timetable ?? ''));
    }));
    if (this.timetables.size > 5000) this.timetables.clear();
  }
  async warm(days: string[]) { for (const day of days) await this.rows(day).catch(() => {}); }
  async searchEvents(q: Preferences) {
    const day = (iso: string) => new Date(Date.parse(iso) + 3 * 3600000).toISOString().slice(0, 10);
    const days = [...new Set([day(q.availableFrom), day(q.availableTo)])];
    let stale = false; const all: any[] = [];
    for (const d of days) {
      try { all.push(...await this.rows(d)); } catch (error) {
        const old = this.days.get(d); if (!old || Date.now() - old.at > STALE) throw error;
        all.push(...old.rows); stale = true;
      }
    }
    const body = { results: [...new Map(all.map(r => [r.id, r])).values()] };
    const events: Event[] = [];
    const from = Date.parse(q.availableFrom), to = Date.parse(q.availableTo), searchDay = day(q.availableFrom);
    const dayStart = Date.parse(`${searchDay}T00:00:00+03:00`) / 1000, weekday = (new Date(`${searchDay}T12:00:00+03:00`).getUTCDay() + 6) % 7;
    for (const row of body.results ?? []) {
      const coords = row.place?.coords; if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lon)) continue;
      const price = parsePrice(row.price ?? '', !!row.is_free), rawCats: string[] = row.categories ?? [];
      // Only KudaGo's own media host: the CSP allows it and the photo belongs to the event card.
      const image = row.images?.find((i: any) => typeof i?.image === 'string' && i.image.startsWith('https://media.kudago.com/'))?.image ?? null;
      const sourceUrl = typeof row.site_url === 'string' && /^https:\/\/(?:www\.)?kudago\.com\//.test(row.site_url) ? row.site_url : null;
      const base = { provider: 'kudago' as const, externalId: String(row.id), title: String(row.title), description: String(row.description ?? '').replace(/<[^>]*>/g, '').slice(0, 1200),
        categories: [...new Set<string>(rawCats.map(c => mapping[c] ?? 'culture'))], tags: row.tags ?? [], ageRestriction: parseInt(row.age_restriction || '0') || 0,
        priceMin: price.min, priceMax: price.max, priceKnown: price.max !== null, isFree: !!row.is_free, availability: 'unknown' as const, venueId: `kudago-${row.place.id}`, venue: row.place.title ?? 'Площадка KudaGo', address: row.place.address ?? 'Адрес уточните у источника',
        latitude: coords.lat, longitude: coords.lon, sourceUrl, imageUrl: image, sourceUpdatedAt: new Date().toISOString(), sourcePublishedAt: row.publication_date ? new Date(row.publication_date * 1000).toISOString() : undefined, demo: false, accent: 'lavender' };
      let visit = false;
      for (const [index, date] of (row.dates ?? []).entries()) {
        if (!date.start) continue;
        const exact = date.end && date.end > date.start && date.end - date.start <= 12 * 3600;
        if (exact || !date.end || date.end === date.start) {
          // Exact session, or a start time only: the end is then a typical length, marked as an estimate.
          const minutes = exact ? (date.end - date.start) / 60 : typicalMinutes(rawCats), end = date.start * 1000 + minutes * 60000;
          if (date.start * 1000 < from || end > to) continue;
          events.push({ ...base, id: `kudago-${row.id}-${index}`, startAt: new Date(date.start * 1000).toISOString(), endAt: new Date(end).toISOString(), flexible: false, durationMinutes: minutes, ...(exact ? {} : { estimate: 'end' as const }) });
        } else if (!visit && date.end > date.start && date.start < dayStart + 86400 && date.end > dayStart && !rawCats.some(c => NOT_A_VISIT.includes(c)) && !/сертификат/i.test(row.title)) {
          // A long run (exhibition, museum programme): visitable only within the place's opening hours that day.
          const hours = openingHours(this.timetables.get(row.place.id) ?? '', weekday); if (!hours) continue;
          const open = Math.max(Date.parse(`${searchDay}T${hours.open}:00+03:00`), date.start * 1000), close = Math.min(Date.parse(`${searchDay}T${hours.close}:00+03:00`), date.end * 1000);
          if (close - open < VISIT_MINUTES * 60000) continue;
          visit = true;
          events.push({ ...base, id: `kudago-${row.id}-v${searchDay}`, startAt: new Date(open).toISOString(), endAt: new Date(close).toISOString(), flexible: true, durationMinutes: VISIT_MINUTES, estimate: 'hours' as const });
        }
      }
    }
    this.events.clear(); events.forEach(e => this.events.set(e.id, e));
    return { events, notices: [stale ? 'KudaGo сейчас недоступен: показаны данные не старше 3 часов. Проверьте информацию у источника.' : 'KudaGo: данные не старше 10 минут. Если источник не указал окончание, длительность оценочная; выставки — по часам работы площадки. Наличие мест источник не подтверждает.'] };
  }
  async getEvent(id: string) { return this.events.get(id); }
}

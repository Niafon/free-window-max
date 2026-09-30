import type { Event, Preferences } from '../../../../packages/contracts/index.js';
import type { EventProvider } from './index.js';
import { providerJson } from './http.js';

// Only unambiguous, mandatory RUB prices can pass a hard budget constraint.
export function parsePrice(value: string, free: boolean): { min: number | null; max: number | null } {
  if (free) return { min: 0, max: 0 };
  const s = value.toLowerCase().replace(/[\u00a0\u202f]/g, ' ').trim();
  const exact = s.match(/^(\d[\d ]*)\s*(?:руб(?:лей|ля|ль|\.)?|₽)\.?$/);
  if (exact) { const n = Number(exact[1].replace(/ /g, '')); return { min: n, max: n }; }
  const range = s.match(/^(?:от\s*)?(\d[\d ]*)\s*(?:до|–|-)\s*(\d[\d ]*)\s*(?:руб(?:лей|ля|ль|\.)?|₽)\.?$/);
  if (range) return { min: Number(range[1].replace(/ /g, '')), max: Number(range[2].replace(/ /g, '')) };
  return { min: null, max: null };
}
const mapping: Record<string, string> = { exhibition: 'culture', theater: 'culture', concert: 'music', cinema: 'cinema', recreation: 'walk', 'games-and-quests': 'games', sport: 'sport', 'entertainment': 'games', 'festival': 'culture' };
const FRESH = 10 * 60000, STALE = 3 * 3600000, PAGES = 5;
// KudaGo answers in 3–5 s (14 s with expanded dates), so events are loaded per Moscow day, cached and pre-warmed; a search only filters them.
export class KudaGoProvider implements EventProvider {
  private days = new Map<string, { at: number; rows: any[] }>();
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
      this.days.set(day, { at: Date.now(), rows }); if (this.days.size > 10) this.days.delete(this.days.keys().next().value!);
      return rows;
    })().finally(() => this.loading.delete(day));
    this.loading.set(day, load); return load;
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
    for (const row of body.results ?? []) {
      const coords = row.place?.coords; if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lon)) continue;
      for (const [index, date] of (row.dates ?? []).entries()) {
        // Long date spans are not an opening-hours schedule. Never invent their duration.
        if (!date.start || !date.end || date.end <= date.start || date.end - date.start > 12 * 3600) continue;
        if (date.start * 1000 < Date.parse(q.availableFrom) || date.end * 1000 > Date.parse(q.availableTo)) continue;
        const price = parsePrice(row.price ?? '', !!row.is_free);
        // Only KudaGo's own media host: the CSP allows it and the photo belongs to the event card.
        const image = row.images?.find((i: any) => typeof i?.image === 'string' && i.image.startsWith('https://media.kudago.com/'))?.image ?? null;
        const sourceUrl = typeof row.site_url === 'string' && /^https:\/\/(?:www\.)?kudago\.com\//.test(row.site_url) ? row.site_url : null;
        events.push({ id: `kudago-${row.id}-${index}`, provider: 'kudago', externalId: String(row.id), title: String(row.title), description: String(row.description ?? '').replace(/<[^>]*>/g, '').slice(0, 1200),
          categories: [...new Set<string>((row.categories ?? []).map((c: string) => mapping[c] ?? 'culture'))], tags: row.tags ?? [],
          ageRestriction: parseInt(row.age_restriction || '0') || 0, startAt: new Date(date.start * 1000).toISOString(), endAt: new Date(date.end * 1000).toISOString(), flexible: false, durationMinutes: (date.end - date.start) / 60,
          priceMin: price.min, priceMax: price.max, priceKnown: price.max !== null, isFree: !!row.is_free, availability: 'unknown', venueId: `kudago-${row.place.id}`, venue: row.place.title ?? 'Площадка KudaGo', address: row.place.address ?? 'Адрес уточните у источника',
          latitude: coords.lat, longitude: coords.lon, sourceUrl, imageUrl: image, sourceUpdatedAt: new Date().toISOString(), sourcePublishedAt: row.publication_date ? new Date(row.publication_date * 1000).toISOString() : undefined, demo: false, accent: 'lavender' });
      }
    }
    this.events.clear(); events.forEach(e => this.events.set(e.id, e));
    return { events, notices: [stale ? 'KudaGo сейчас недоступен: показаны данные не старше 3 часов. Проверьте информацию у источника.' : 'KudaGo: данные не старше 10 минут; проверены только события с точным началом и окончанием. Наличие мест источник не подтверждает.'] };
  }
  async getEvent(id: string) { return this.events.get(id); }
}

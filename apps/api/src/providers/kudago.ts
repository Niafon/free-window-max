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
export class KudaGoProvider implements EventProvider {
  private cache = new Map<string, { at: number; events: Event[] }>();
  private events = new Map<string, Event>();
  async searchEvents(q: Preferences) {
    const key = `${q.availableFrom}/${q.availableTo}`; const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 300000) return { events: cached.events, notices: ['Данные KudaGo из кэша, не старше 5 минут. Наличие мест уточните у организатора.'] };
    const url = new URL('https://kudago.com/public-api/v1.4/events/');
    Object.entries({ location: 'msk', page_size: '100', actual_since: String(Math.floor(Date.parse(q.availableFrom) / 1000)), actual_until: String(Math.floor(Date.parse(q.availableTo) / 1000)), expand: 'place,dates', fields: 'id,title,description,categories,tags,age_restriction,dates,price,is_free,place,site_url,publication_date,images', text_format: 'text' }).forEach(([k, v]) => url.searchParams.set(k, v));
    let body: any;
    try { body = await providerJson(url, 'EVENT'); } catch (error) {
      if (cached && Date.now() - cached.at < 3600000) return { events: cached.events, notices: ['KudaGo недоступен: последние данные не старше часа. Проверьте информацию у источника.'] };
      throw error;
    }
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
    this.events.clear(); events.forEach(e => this.events.set(e.id, e)); this.cache.set(key, { at: Date.now(), events });
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    return { events, notices: ['KudaGo: проверены только события с точным началом и окончанием. Наличие мест источник не подтверждает.'] };
  }
  async getEvent(id: string) { return this.events.get(id); }
}

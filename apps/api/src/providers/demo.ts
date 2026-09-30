import data from '../../../../demo-data/events.json';
import type { Event, Preferences, Origin } from '../../../../packages/contracts/index.js';
import type { EventProvider, RouteProvider } from './index.js';
import { AppError } from '../errors.js';
export class DemoEventProvider implements EventProvider {
  private last = new Map<string, Event>();
  async searchEvents(q: Preferences) {
    const date = new Date(Date.parse(q.availableFrom) + 3 * 3600000).toISOString().slice(0, 10);
    const events: Event[] = data.map(e => ({ id: `demo-${e.id}-${date}`, provider: 'demo', externalId: e.id,
      title: e.title, description: e.description, categories: [e.category], tags: [e.category], ageRestriction: e.age,
      startAt: `${date}T${e.start}:00+03:00`, endAt: `${date}T${e.end}:00+03:00`, flexible: !!e.flexible,
      durationMinutes: e.duration, priceMin: e.price, priceMax: e.price, priceKnown: e.price !== null, isFree: e.price === 0,
      availability: e.availability === 'sold_out' ? 'sold_out' : 'available', venueId: `demo-${e.id}`, venue: e.venue,
      address: e.address, latitude: e.lat, longitude: e.lon, sourceUrl: null, imageUrl: null,
      sourceUpdatedAt: '2026-09-30T00:00:00+03:00', demo: true, accent: e.accent }));
    this.last.clear(); events.forEach(e => this.last.set(e.id, e));
    return { events, notices: ['Тестовые данные: названия площадок, цены, расписание и места смоделированы; бронирование недоступно.'] };
  }
  async getEvent(id: string) { return this.last.get(id); }
}
export class DemoRouteProvider implements RouteProvider {
  async getRoute(origin: Origin, event: Event) {
    if (!event.demo) throw new AppError('ROUTE_PROVIDER_ERROR', 'Для реальных событий нужен реальный провайдер маршрутов', 503, true);
    const index = ['mirea', 'stromynka', 'southwest', 'center'].indexOf(origin.preset ?? '');
    const item = data.find(d => d.id === event.externalId);
    if (index < 0 || !item) throw new AppError('ROUTE_PROVIDER_ERROR', 'Для тестовых данных выберите одну из четырёх точек старта', 422);
    return { outbound: item.routes[index], inbound: item.routes[index] + 2, mode: 'transit' as const, modelled: true, provider: 'demo-table-v1' };
  }
}

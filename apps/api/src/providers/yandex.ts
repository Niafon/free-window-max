import type { Event, Origin } from '../../../../packages/contracts/index.js';
import type { RouteProvider } from './index.js';
import { providerJson } from './http.js';
import { AppError } from '../errors.js';
const HOUR = 3600000, CACHE_TTL = 6 * HOUR, CACHE_SIZE = 500;
// ~100 m precision: nearby starts share cached routes and exact coordinates are never kept.
const point = (lat: number, lon: number) => `${lat.toFixed(3)},${lon.toFixed(3)}`;
export class YandexRouteProvider implements RouteProvider {
  private cache = new Map<string, { at: number; minutes: number }>();
  constructor(private key: string, private reserve: () => Promise<void> = async () => {}) {}
  async minutes(from: string, to: string, departure: string) {
    // Transit time within the same departure hour is reused instead of spending the daily quota.
    const key = `${from}|${to}|${Math.floor(Date.parse(departure) / HOUR)}`, hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.minutes;
    const minutes = await this.request(from, to, departure);
    this.cache.set(key, { at: Date.now(), minutes }); if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return minutes;
  }
  private async request(from: string, to: string, departure: string) {
    await this.reserve();
    const url = new URL('https://api.routing.yandex.net/v2/distancematrix');
    Object.entries({ apikey: this.key, origins: from, destinations: to, mode: 'transit', departure_time: String(Math.floor(Date.parse(departure) / 1000)) }).forEach(([k, v]) => url.searchParams.set(k, v));
    const result = await providerJson(url, 'ROUTE', 0);
    const element = result.rows?.[0]?.elements?.[0];
    if (element?.status !== 'OK' || !Number.isFinite(element.duration?.value) || element.duration.value < 0) throw new AppError('ROUTE_PROVIDER_ERROR', 'Маршрут общественным транспортом не найден', 503, true);
    return Math.ceil(element.duration.value / 60);
  }
  async getRoute(origin: Origin, event: Event, departure: string, returnAt: string) {
    const a = point(origin.lat, origin.lon), b = point(event.latitude, event.longitude);
    const [outbound, inbound] = await Promise.all([this.minutes(a, b, departure), this.minutes(b, a, returnAt)]);
    return { outbound, inbound, mode: 'transit' as const, modelled: false, provider: 'yandex' };
  }
}

import type { Event, Origin } from '../../../../packages/contracts/index.js';
import type { RouteProvider } from './index.js';
import { providerJson } from './http.js';
import { AppError } from '../errors.js';
export class YandexRouteProvider implements RouteProvider {
  constructor(private key: string, private reserve: () => Promise<void> = async () => {}) {}
  async minutes(from: string, to: string, departure: string) {
    await this.reserve();
    const url = new URL('https://api.routing.yandex.net/v2/distancematrix');
    Object.entries({ apikey: this.key, origins: from, destinations: to, mode: 'transit', departure_time: String(Math.floor(Date.parse(departure) / 1000)) }).forEach(([k, v]) => url.searchParams.set(k, v));
    const result = await providerJson(url, 'ROUTE', 0);
    const element = result.rows?.[0]?.elements?.[0];
    if (element?.status !== 'OK' || !Number.isFinite(element.duration?.value) || element.duration.value < 0) throw new AppError('ROUTE_PROVIDER_ERROR', 'Маршрут общественным транспортом не найден', 503, true);
    return Math.ceil(element.duration.value / 60);
  }
  async getRoute(origin: Origin, event: Event, departure: string, returnAt: string) {
    const a = `${origin.lat},${origin.lon}`, b = `${event.latitude},${event.longitude}`;
    const [outbound, inbound] = await Promise.all([this.minutes(a, b, departure), this.minutes(b, a, returnAt)]);
    return { outbound, inbound, mode: 'transit' as const, modelled: false, provider: 'yandex' };
  }
}

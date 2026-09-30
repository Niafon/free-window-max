import { describe, it, expect, vi, afterEach } from 'vitest';
import { YandexRouteProvider } from '../apps/api/src/providers/yandex.js';
import { event, pref } from './fixtures.js';
afterEach(() => vi.restoreAllMocks());
describe('Маршруты Яндекса', () => {
  it('Повтор того же маршрута в пределах часа не тратит квоту', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ rows: [{ elements: [{ status: 'OK', duration: { value: 1260 } }] }] })));
    let reserved = 0; const provider = new YandexRouteProvider('test-key', async () => { reserved++; });
    const p = pref(); const a = await provider.getRoute(p.origin, event, p.availableFrom, event.endAt);
    const b = await provider.getRoute({ ...p.origin, lat: p.origin.lat + 0.0001 }, event, p.availableFrom, event.endAt);
    expect(a).toEqual(b); expect(a.outbound).toBe(21); expect(a.modelled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2); expect(reserved).toBe(2);
    expect(String(fetch.mock.calls[0][0])).not.toContain(String(p.origin.lat));
  });
  it('Ошибка маршрута не кэшируется и не превращается во время', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ rows: [{ elements: [{ status: 'FAIL' }] }] })));
    const provider = new YandexRouteProvider('test-key'); const p = pref();
    await expect(provider.getRoute(p.origin, event, p.availableFrom, event.endAt)).rejects.toMatchObject({ code: 'ROUTE_PROVIDER_ERROR' });
  });
});

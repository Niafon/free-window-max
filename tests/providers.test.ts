import { describe, it, expect, vi, afterEach } from 'vitest';
import { YandexRouteProvider } from '../apps/api/src/providers/yandex.js';
import { KudaGoProvider, openingHours, parsePrice } from '../apps/api/src/providers/kudago.js';
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
describe('События KudaGo', () => {
  it('Берёт фото только с медиасервера KudaGo', async () => {
    const p = pref(), start = Date.parse(p.availableFrom) / 1000 + 1800;
    const row = (id: number, image: string) => ({ id, title: `Событие ${id}`, description: '', categories: ['exhibition'], dates: [{ start, end: start + 3600 }], price: '500 рублей', is_free: false, place: { id, title: 'Площадка', address: 'Москва', coords: { lat: 55.7, lon: 37.6 } }, images: [{ image }] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ results: [row(1, 'https://media.kudago.com/images/event/a.jpg'), row(2, 'https://evil.example/b.jpg')] })));
    const { events } = await new KudaGoProvider().searchEvents(p);
    expect(events.find(e => e.externalId === '1')?.imageUrl).toBe('https://media.kudago.com/images/event/a.jpg');
    expect(events.find(e => e.externalId === '2')?.imageUrl).toBeNull();
  });
  it('Грузит день целиком постранично, повторный поиск в тот же день — из кэша', async () => {
    const p = pref(), start = Date.parse(p.availableFrom) / 1000 + 1800;
    const row = (id: number) => ({ id, title: `Событие ${id}`, categories: [], dates: [{ start, end: start + 3600 }], price: '', is_free: true, place: { id, title: 'Площадка', coords: { lat: 55.7, lon: 37.6 } } });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => new Response(JSON.stringify({ count: 150, results: new URL(String(url)).searchParams.get('page') === '1' ? [row(1)] : [row(2)] })));
    const provider = new KudaGoProvider();
    const first = await provider.searchEvents(p); expect(first.events.map(e => e.externalId).sort()).toEqual(['1', '2']); expect(fetch).toHaveBeenCalledTimes(3); // 2 pages + opening hours
    await provider.searchEvents({ ...p, availableTo: new Date(Date.parse(p.availableTo) - 600000).toISOString() }); expect(fetch).toHaveBeenCalledTimes(3);
  });
});
describe('Часы работы и оценки KudaGo', () => {
  it.each([
    ['ежедневно 12:00–19:00', 2, { open: '12:00', close: '19:00' }],
    ['пн–пт 12:00–22:00, сб, вс 10:00–22:00', 5, { open: '10:00', close: '22:00' }],
    ['пн–пт 12:00–22:00, сб, вс 10:00–22:00', 0, { open: '12:00', close: '22:00' }],
    ['вт–вс 11:00–20:00', 0, null],
    ['пт–вт 10:00–18:00', 1, { open: '10:00', close: '18:00' }],
    ['ср 10:00–21:00; чт–вс 10:00–24:00', 4, { open: '10:00', close: '23:59' }],
    ['по предварительной записи', 3, null],
  ])('%s, день %i', (text, weekday, expected) => expect(openingHours(String(text), Number(weekday))).toEqual(expected));
  it('Цена с льготами остаётся точной', () => expect(parsePrice('500 рублей, есть льготы', false)).toEqual({ min: 500, max: 500 }));
  it('Событие без окончания получает оценку, выставка — свободное посещение по часам площадки', async () => {
    const p = pref(), day = p.availableFrom.slice(0, 10), start = Date.parse(`${day}T19:00:00+03:00`) / 1000;
    const place = (id: number) => ({ id, title: `Площадка ${id}`, address: 'Москва', coords: { lat: 55.7, lon: 37.6 } });
    const rows = [
      { id: 10, title: 'Концерт', categories: ['concert'], dates: [{ start, end: start }], price: '800 рублей', is_free: false, place: place(1) },
      { id: 11, title: 'Выставка', categories: ['exhibition'], dates: [{ start: start - 30 * 86400, end: start + 30 * 86400 }], price: '', is_free: true, place: place(2) },
      { id: 12, title: 'Подарочный сертификат', categories: ['stock'], dates: [{ start: start - 30 * 86400, end: start + 30 * 86400 }], price: '', is_free: true, place: place(2) },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => new Response(JSON.stringify(String(url).includes('/places/') ? { results: [{ id: 2, timetable: 'ежедневно 10:00–22:00' }] } : { count: 3, results: rows })));
    const { events } = await new KudaGoProvider().searchEvents(p);
    const concert = events.find(e => e.externalId === '10')!, show = events.find(e => e.externalId === '11')!;
    expect(concert).toMatchObject({ estimate: 'end', durationMinutes: 120, flexible: false }); expect(Date.parse(concert.endAt) - Date.parse(concert.startAt)).toBe(120 * 60000);
    expect(show).toMatchObject({ estimate: 'hours', flexible: true, durationMinutes: 60, startAt: new Date(`${day}T10:00:00+03:00`).toISOString(), endAt: new Date(`${day}T22:00:00+03:00`).toISOString() });
    expect(events.some(e => e.externalId === '12')).toBe(false);
  });
});

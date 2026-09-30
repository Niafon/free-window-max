import { z } from 'zod';

export const categories = ['culture', 'games', 'walk', 'sport', 'food', 'music', 'cinema'] as const;
export const categoryNames: Record<string, string> = { culture: 'Культура', games: 'Игры', walk: 'Прогулки', sport: 'Спорт', food: 'Еда', music: 'Музыка', cinema: 'Кино' };
export const originSchema = z.object({ lat: z.number().min(55.1).max(56.2), lon: z.number().min(36.5).max(38.5), label: z.string().max(120).optional(), preset: z.string().max(40).optional() });
export const preferencesSchema = z.object({
  dataMode: z.enum(['demo', 'live']).default('demo'),
  availableFrom: z.iso.datetime({ offset: true }), availableTo: z.iso.datetime({ offset: true }),
  origin: originSchema, budget: z.number().int().min(0).max(50000), maxTravelMinutes: z.number().int().min(5).max(120),
  categories: z.array(z.enum(categories)).max(7).default([]), excludedCategories: z.array(z.enum(categories)).max(7).default([]),
  transportBudget: z.number().int().min(0).max(10000).default(0),
  age: z.number().int().min(18).max(100).default(18), context: z.enum(['any', 'calm', 'active', 'date']).default('any'),
}).refine(p => Date.parse(p.availableTo) > Date.parse(p.availableFrom), { message: 'Конец окна должен быть позже начала', path: ['availableTo'] })
  .refine(p => Date.parse(p.availableTo) - Date.parse(p.availableFrom) <= 12 * 3600000, { message: 'Максимальная длина окна — 12 часов', path: ['availableTo'] });
export type Preferences = z.infer<typeof preferencesSchema>;
export type Origin = z.infer<typeof originSchema>;
export interface Event {
  id: string; provider: 'demo' | 'kudago'; externalId: string; title: string; description: string;
  categories: string[]; tags: string[]; ageRestriction: number; startAt: string; endAt: string;
  flexible: boolean; durationMinutes: number; priceMin: number | null; priceMax: number | null; priceKnown: boolean;
  isFree: boolean; availability: 'available' | 'unknown' | 'sold_out'; venueId: string; venue: string;
  address: string; latitude: number; longitude: number; sourceUrl: string | null; imageUrl: string | null;
  sourceUpdatedAt: string; sourcePublishedAt?: string; demo: boolean; accent: string;
  // Where the user books or buys a ticket; null for test data (booking is only simulated) or when the source has no page.
  bookingUrl: string | null;
  // 'end': the source gave only a start time; 'hours': a free visit within the place's opening hours.
  estimate?: 'end' | 'hours';
}
export interface Travel { outbound: number; inbound: number; mode: 'transit'; modelled: boolean; provider: string; }
export interface Member { userId: string; name: string; preferences: Preferences | null; }
export interface Candidate {
  event: Event; score: number; reasons: string[]; startAt: string; endAt: string;
  totalPrice: number; members: Array<{ name: string; travel: Travel; arriveAt: string; returnAt: string; spareMinutes: number }>;
  routeUrl: string; sourceUrl: string | null; warnings: string[];
}
export interface SearchResult {
  id: string; results: Candidate[]; excluded: Array<{ id: string; title: string; reasons: string[] }>;
  compromises: Array<{ label: string; field: string; value: number; count: number }>;
  commonWindow: { from: string; to: string } | null; mode: string; notices: string[]; createdAt: string;
  // Internal: provider timings for structured logs (TZ §27); stripped by the response schema.
  timing?: { eventsMs: number; routesMs: number };
}
export const presets = [
  { id: 'mirea', label: 'МИРЭА · Вернадского, 78', lat: 55.6706, lon: 37.4802 },
  { id: 'stromynka', label: 'МИРЭА · Стромынка, 20', lat: 55.7944, lon: 37.7013 },
  { id: 'southwest', label: 'Метро Юго-Западная', lat: 55.6637, lon: 37.4837 },
  { id: 'center', label: 'Метро Парк культуры', lat: 55.7352, lon: 37.594 },
];

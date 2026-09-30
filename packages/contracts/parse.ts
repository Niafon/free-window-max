import type { categories } from './index.js';
type Category = typeof categories[number];
// Rule-based parsing of a chat request (TZ §15): the main scenario never depends on an LLM.
export type ParsedRequest = { from?: string; to?: string; budget?: number; maxTravelMinutes?: number; categories: Category[]; excludedCategories: Category[]; partySize?: number };
// Moscow calendar day shifted by `offset` days, as YYYY-MM-DD.
export const moscowDay = (offset = 0, now = Date.now()) => new Date(now + 3 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
const at = (day: string, hhmm: string) => `${day}T${hhmm.padStart(5, '0')}:00+03:00`;
const hhmm = (h: string, m?: string) => Number(h) <= 23 && Number(m ?? 0) <= 59 ? `${h.padStart(2, '0')}:${(m ?? '00').padStart(2, '0')}` : null;
function dayOf(text: string, now: number): string | null {
  if (/послезавтра/.test(text)) return moscowDay(2, now);
  if (/завтра/.test(text)) return moscowDay(1, now);
  const d = text.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})(?=\s|$|,)/);
  if (d) {
    const today = moscowDay(0, now), year = Number(today.slice(0, 4));
    let day = `${year}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}`;
    if (day < today) day = `${year + 1}${day.slice(4)}`;
    return Number.isFinite(Date.parse(day)) ? day : null;
  }
  return null;
}
// "18:30–21:30", "завтра 18:30-21:30", "02.10 18:30–21:30" → ISO window in Moscow time.
export function parseWindow(text: string, now = Date.now()): { from: string; to: string } | null {
  const m = text.trim().toLowerCase().match(/^(?:(сегодня|завтра|послезавтра|\d{1,2}\.\d{1,2})\s+)?(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const a = hhmm(m[2], m[3]), b = hhmm(m[4], m[5]); if (!a || !b) return null;
  return span(dayOf(m[1] ?? '', now) ?? moscowDay(0, now), a, b);
}
function span(day: string, a: string, b: string) {
  const from = at(day, a); let to = at(day, b);
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) return null;
  // An overnight window such as 22:00–01:00 ends on the next day.
  if (Date.parse(to) <= Date.parse(from)) to = new Date(Date.parse(to) + 86400000).toISOString();
  return { from, to };
}
const words: Array<[Category, RegExp]> = [
  ['games', /игр|настолк|квиз|квест/], ['culture', /музе|выставк|театр|галере|культур|экскурс/], ['food', /\sед[аыу]\s|кафе|поесть|ресторан|кофе|перекус/],
  ['music', /музык|концерт|джаз|рок/], ['sport', /спорт|актив|каток|скалодром|бассейн/], ['walk', /прогул|парк|погулять/], ['cinema', /кино|фильм/],
];
export function parseRequest(input: string, now = Date.now()): ParsedRequest {
  let text = ' ' + input.toLowerCase().replace(/ё/g, 'е').replace(/[,;!?]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const r: ParsedRequest = { categories: [], excludedCategories: [] };
  const take = (re: RegExp) => { const m = text.match(re); if (m) text = text.replace(m[0], ' '); return m; };
  // Money and minutes first, so "до 1000" or "30 минут" are never read as clock time.
  if (/бесплатн|без денег|даром/.test(text)) r.budget = 0;
  const money = take(/(\d+(?:[.,]\d)?)\s*тыс\S*/) ?? take(/(\d[\d ]*\d|\d)\s*(?:₽|руб\S*|р(?=[\s.]))/) ?? take(/(?:до|не дороже|бюджет|за)\s*(\d{3,5})(?!\s*(?:мин|:))/);
  if (money) { const n = Math.round(Number(money[1].replace(/ /g, '').replace(',', '.')) * (/тыс/.test(money[0]) ? 1000 : 1)); if (n >= 0 && n <= 50000) r.budget = n; }
  const travel = take(/(?:не дальше|до|максимум|не больше)?\s*(\d{1,3})\s*мин\S*/);
  if (travel) { const n = Number(travel[1]); if (n >= 5 && n <= 120) r.maxTravelMinutes = n; }
  else if (/рядом|недалеко|поблизости/.test(text)) r.maxTravelMinutes = 20;
  const date = take(/\s(\d{1,2}\.\d{1,2})(?=\s)/);
  const day = dayOf(date ? ` ${date[1]} ` : text, now) ?? moscowDay(0, now);
  const today = day === moscowDay(0, now), nowIso = new Date(Math.ceil((now + 60000) / 60000) * 60000).toISOString();
  const hours = take(/на\s*(полтора|пару|два|три|четыре|час|\d+(?:[.,]5)?)\s*(?:час\S*|ч)?(?=\s)/);
  const named: Record<string, number> = { полтора: 90, пару: 120, два: 120, три: 180, четыре: 240, час: 60 };
  const duration = hours ? named[hours[1]] ?? Number(hours[1].replace(',', '.')) * 60 : undefined;
  // Explicit range: "18:30–21:30", "с 19 до 22", "с 19:00 до 22:30".
  const range = text.match(/\s(?:с\s*)?(\d{1,2})(?::(\d{2}))?\s*(?:[-–—]|до)\s*(\d{1,2})(?::(\d{2}))?(?=\s)/);
  const a = range && hhmm(range[1], range[2]), b = range && hhmm(range[3], range[4]);
  if (a && b) Object.assign(r, span(day, a, b));
  else {
    let start: string | undefined;
    const clock = text.match(/\s(?:с|в|от)\s*(\d{1,2})(?::(\d{2}))?(?=\s)/), c = clock && hhmm(clock[1], clock[2]);
    if (c) start = at(day, c);
    else if (/вечер/.test(text)) start = at(day, '18:30');
    else if (/после пар|после учеб/.test(text)) start = at(day, '17:30');
    else if (/утр/.test(text)) start = at(day, '10:00');
    else if (/днем|обед/.test(text)) start = at(day, '13:00');
    else if (duration || /сейчас|сегодня|завтра|послезавтра/.test(text) || date) start = today ? nowIso : at(day, '18:30');
    if (start && today && Date.parse(start) < now) start = nowIso;
    if (start) { r.from = start; r.to = new Date(Date.parse(start) + (duration ?? (/вечер/.test(text) ? 180 : 120)) * 60000).toISOString(); }
  }
  for (const [cat, re] of words) {
    if (new RegExp(String.raw`(?:не|без|кроме)\s+(?:\S+\s+)?(?:${re.source})`).test(text)) r.excludedCategories.push(cat);
    else if (re.test(text) && r.categories.length < 2) r.categories.push(cat);
  }
  if (/с девушк|с парн|с друг|с подруг|вдвоем/.test(text)) r.partySize = 2;
  return r;
}

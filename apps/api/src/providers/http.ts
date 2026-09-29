import { AppError } from '../errors.js';
export async function providerJson(url: URL, provider: 'EVENT' | 'ROUTE', retries = 1): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500), headers: { Accept: 'application/json', 'User-Agent': 'Okno-MVP/1.0 (+https://github.com/Niafon/free-window-max)' } });
      if (!response.ok) { if (response.status >= 500 && attempt < retries) continue; throw new Error('Provider HTTP failure'); }
      return await response.json();
    } catch { if (attempt < retries) continue; throw new AppError(`${provider}_PROVIDER_ERROR`, provider === 'EVENT' ? 'Источник событий временно недоступен. Попробуйте ещё раз.' : 'Не удалось проверить маршрут. Попробуйте ещё раз; время не будет угадано.', 503, true); }
  }
}

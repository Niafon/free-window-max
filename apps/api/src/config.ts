import { z } from 'zod';
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = z.object({
    PORT: z.coerce.number().default(3000), HOST: z.string().default('127.0.0.1'),
    PUBLIC_URL: z.string().url().default('http://localhost:3000'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(1).default(0),
    DATABASE_URL: z.string().default('postgres://okno:okno_local_only@localhost:5432/okno'),
    BOT_TOKEN: z.string().default(''), BOT_USERNAME: z.string().default(''),
    MAX_API_URL: z.string().url().default('https://platform-api2.max.ru'),
    MAX_MODE: z.enum(['off', 'polling', 'webhook']).default('off'), MAX_WEBHOOK_SECRET: z.string().default(''),
    EVENT_PROVIDER: z.enum(['demo', 'kudago']).default('demo'), ROUTE_PROVIDER: z.enum(['demo', 'yandex']).default('demo'),
    YANDEX_MAPS_KEY: z.string().default(''), YANDEX_DAILY_LIMIT: z.coerce.number().int().min(0).max(100).default(80), DEMO_AUTH: z.string().default('false').transform(v => v === 'true'),
    DEMO_ACCESS_KEY: z.string().default(''), INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().default(86400), LOG_LEVEL: z.string().default('info'),
  }).parse(env);
  if (c.ROUTE_PROVIDER === 'yandex' && !c.YANDEX_MAPS_KEY) throw new Error('YANDEX_MAPS_KEY is required');
  if (c.MAX_MODE !== 'off' && !c.BOT_TOKEN) throw new Error('BOT_TOKEN is required');
  if (c.MAX_MODE === 'webhook' && (c.MAX_WEBHOOK_SECRET.length < 32 || !c.PUBLIC_URL.startsWith('https://'))) throw new Error('Webhook requires HTTPS and a 32-character secret');
  if (c.DEMO_AUTH && !['localhost', '127.0.0.1'].includes(new URL(c.PUBLIC_URL).hostname) && c.DEMO_ACCESS_KEY.length < 24) throw new Error('Public demo requires a DEMO_ACCESS_KEY of at least 24 characters');
  return c;
}
export type Config = ReturnType<typeof readConfig>;

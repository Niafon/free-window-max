import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { validateInitData, equalSecret } from './auth/index.js';
import { Service, type Identity } from './search/service.js';
import type { Config } from './config.js';
import type { Database } from './db/index.js';
import { users } from './db/schema.js';
import { AppError } from './errors.js';
import { preferencesSchema, categories, presets } from '../../../packages/contracts/index.js';
import { candidateSchema, errorSchema, searchResultSchema, okSchema } from '../../../packages/contracts/responses.js';

declare module 'fastify' { interface FastifyRequest { identity: Identity; } }
const idParams = z.object({ id: z.uuid() });
const eventParams = z.object({ id: z.string().min(1).max(180) });
const generic = z.object({}).passthrough();
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema, 410: errorSchema, 422: errorSchema, 429: errorSchema, 500: errorSchema, 503: errorSchema };
export async function buildApp(config: Config, database: Database, quiet = false) {
  const app = Fastify({ logger: quiet ? false : { level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-max-init-data', 'req.headers.x-max-bot-api-secret', 'req.body', 'res.headers.set-cookie'], serializers: { req: r => ({ method: r.method, url: (r.url ?? '').split('?')[0] }) } }, bodyLimit: 32768, trustProxy: config.TRUST_PROXY_HOPS ? (_address, hop) => hop < config.TRUST_PROXY_HOPS : false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://st.max.ru'], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ['https://*.max.ru', 'https://max.ru'], objectSrc: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'cross-origin' }, frameguard: false });
  await app.register(rateLimit, { max: 150, timeWindow: '1 minute', errorResponseBuilder: () => ({ error: { code: 'RATE_LIMITED', message: 'Слишком много запросов. Подождите минуту', retryable: true } }) });
  await app.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'ОКНО API', version: '1.0.0', description: 'MAX mini app. Демо явно обозначено; реальные данные включаются dataMode=live.' }, servers: [{ url: config.PUBLIC_URL }], components: { securitySchemes: { MaxInitData: { type: 'apiKey', in: 'header', name: 'X-Max-Init-Data' }, DemoCookie: { type: 'apiKey', in: 'cookie', name: 'okno_demo' } } } }, transform: jsonSchemaTransform });
  await app.register(swaggerUI, { routePrefix: '/docs', staticCSP: true });
  const service = new Service(database, config);
  let botHandler: ((update: any) => Promise<void>) | undefined;
  app.decorateRequest('identity', null as unknown as Identity);
  const demoUsers = new Map<string, { identity: Identity; expiresAt: number }>();
  const auth = async (req: any) => {
    const raw = req.headers['x-max-init-data'];
    if (raw) { req.identity = validateInitData(String(raw), config.BOT_TOKEN, config.INIT_DATA_MAX_AGE_SECONDS); return; }
    const session = req.cookies.okno_demo;
    const entry = demoUsers.get(session);
    if (config.DEMO_AUTH && entry && entry.expiresAt > Date.now()) { req.identity = entry.identity; return; }
    if (entry) demoUsers.delete(session);
    throw new AppError('UNAUTHORIZED', 'Откройте приложение из MAX или войдите в локальный деморежим', 401);
  };
  app.addHook('onRequest', async (req) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.url !== '/max/webhook') {
      const origin = req.headers.origin;
      const local = ['localhost', '127.0.0.1'].includes(new URL(config.PUBLIC_URL).hostname);
      const allowed = [config.PUBLIC_URL, ...(local ? ['http://localhost:5173', 'http://127.0.0.1:5173', `http://localhost:${config.PORT}`, `http://127.0.0.1:${config.PORT}`] : [])];
      if (origin && !allowed.includes(origin)) throw new AppError('FORBIDDEN', 'Недопустимый источник запроса', 403);
    }
  });
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, retryable: err.retryable } });
    if (err.validation || err instanceof z.ZodError || err.statusCode === 400) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Проверьте время, точку старта и ограничения. Данные не потеряны.', retryable: false } });
    if (err.statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Подождите минуту и повторите', retryable: true } });
    req.log.error({ code: 'INTERNAL_ERROR', requestId: req.id }, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Не удалось завершить действие. Попробуйте ещё раз', retryable: true } });
  });
  app.get('/health', { schema: { response: { 200: z.object({ status: z.literal('ok'), database: z.literal('ready') }), 503: errorSchema } } }, async () => { await database.pool.query('SELECT 1'); return { status: 'ok' as const, database: 'ready' as const }; });
  app.get('/api/v1/config', { schema: { response: { 200: generic } } }, async () => ({ demoAuth: config.DEMO_AUTH, demoKeyRequired: !!config.DEMO_ACCESS_KEY, botUsername: config.BOT_USERNAME, liveAvailable: !!config.YANDEX_MAPS_KEY, presets, categories, timezone: 'Europe/Moscow', yandexDailyLimit: config.YANDEX_DAILY_LIMIT }));
  app.post('/api/v1/auth/demo', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { body: z.object({ name: z.string().min(1).max(40), accessKey: z.string().max(200).optional() }), response: { 200: generic, ...errors } } }, async (req, reply) => {
    if (!config.DEMO_AUTH || (config.DEMO_ACCESS_KEY && !equalSecret(req.body.accessKey ?? '', config.DEMO_ACCESS_KEY))) throw new AppError('UNAUTHORIZED', 'Демо недоступно или неверный код доступа', 401);
    if (demoUsers.size > 1000) demoUsers.clear();
    const token = randomBytes(32).toString('base64url'), identity = { id: `demo:${randomBytes(16).toString('hex')}`, name: req.body.name };
    demoUsers.set(token, { identity, expiresAt: Date.now() + 86400000 }); await service.user(identity);
    reply.setCookie('okno_demo', token, { httpOnly: true, secure: config.PUBLIC_URL.startsWith('https://'), sameSite: 'lax', path: '/', maxAge: 86400 }); return { user: identity, mode: 'demo' };
  });
  app.get('/api/v1/me', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], response: { 200: generic, ...errors } } }, async req => { const u = await service.user(req.identity); return { ...u, authMode: req.identity.maxId ? 'max' : 'demo' }; });
  app.put('/api/v1/me/interests', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], body: z.object({ interests: z.array(z.enum(categories)).max(7) }), response: { 200: okSchema, ...errors } } }, async req => { await service.user(req.identity); await service.db.update(users).set({ interests: req.body.interests }).where(eq(users.id, req.identity.id)); return { ok: true }; });
  app.post('/api/v1/search', { preHandler: auth, config: { rateLimit: { max: 12, timeWindow: '1 minute' } }, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], body: preferencesSchema, response: { 200: searchResultSchema, ...errors } } }, async req => service.search(req.identity, req.body));
  app.get('/api/v1/search/:id', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], params: idParams, response: { 200: searchResultSchema, ...errors } } }, async req => service.getSearch(req.params.id, req.identity));
  app.post('/api/v1/sessions', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], body: z.object({ title: z.string().min(1).max(80).default('Пойдём вместе'), preferences: preferencesSchema.optional() }), response: { 201: generic, ...errors } } }, async (req, reply) => { reply.code(201); return service.createSession(req.identity, req.body.title, req.body.preferences); });
  const sessionView = (s: Awaited<ReturnType<Service['session']>>, u: Identity) => ({ ...s, members: s.members.map(m => ({ userId: m.userId, name: m.name, ready: !!m.preferences, preferences: m.userId === u.id ? m.preferences : null })) });
  app.get('/api/v1/sessions/:id', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], params: idParams, response: { 200: generic, ...errors } } }, async req => sessionView(await service.session(req.params.id, req.identity), req.identity));
  app.get('/api/v1/invites/:id', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], params: idParams, response: { 200: generic, ...errors } } }, async req => { const s = await service.session(req.params.id, req.identity, true); return { id: s.id, title: s.title, memberCount: s.members.length, expiresAt: s.expiresAt }; });
  app.post('/api/v1/sessions/:id/join', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], params: idParams, response: { 200: generic, ...errors } } }, async req => sessionView(await service.join(req.params.id, req.identity), req.identity));
  app.put('/api/v1/sessions/:id/preferences', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], params: idParams, body: preferencesSchema, response: { 200: generic, ...errors } } }, async req => sessionView(await service.preferences(req.params.id, req.identity, req.body), req.identity));
  app.post('/api/v1/sessions/:id/search', { preHandler: auth, config: { rateLimit: { max: 6, timeWindow: '1 minute' } }, schema: { params: idParams, response: { 200: searchResultSchema, ...errors } } }, async req => service.groupSearch(req.params.id, req.identity));
  const selectBody = z.object({ searchId: z.uuid(), eventId: z.string().min(1).max(180) });
  const selection = z.object({ id: z.uuid(), candidate: candidateSchema, shareUrl: z.string() });
  app.post('/api/v1/plans', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], body: selectBody, response: { 201: selection, ...errors } } }, async (req, reply) => { reply.code(201); return service.select(req.identity, req.body.searchId, req.body.eventId); });
  app.post('/api/v1/sessions/:id/select', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], params: idParams, body: selectBody, response: { 201: selection, ...errors } } }, async (req, reply) => { reply.code(201); return service.select(req.identity, req.body.searchId, req.body.eventId, req.params.id); });
  app.get('/api/v1/plans/:id', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], params: idParams, response: { 200: z.object({ id: z.uuid(), candidate: candidateSchema }), ...errors } } }, async req => service.getPlan(req.params.id, req.identity));
  app.post('/api/v1/events/:id/feedback', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], params: eventParams, body: z.object({ value: z.union([z.literal(1), z.literal(-1)]) }), response: { 200: okSchema, ...errors } } }, async req => service.rate(req.identity, req.params.id, req.body.value));
  app.post('/api/v1/metrics', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], body: z.object({ kind: z.enum(['route_open', 'source_open', 'share', 'app_open']), durationMs: z.number().int().min(0).max(86400000).optional() }), response: { 200: okSchema, ...errors } } }, async req => { await database.pool.query('INSERT INTO metrics(kind,duration_ms) VALUES($1,$2)', [req.body.kind, req.body.durationMs ?? null]); return { ok: true }; });
  app.get('/api/v1/quota', { preHandler: auth, schema: { security: [{ MaxInitData: [] }, { DemoCookie: [] }], response: { 200: z.object({ used: z.number(), limit: z.number() }), ...errors } } }, async () => { const r = await database.pool.query("SELECT used FROM provider_quota WHERE day=(now() AT TIME ZONE 'Europe/Moscow')::date"); return { used: r.rows[0]?.used ?? 0, limit: config.YANDEX_DAILY_LIMIT }; });
  app.post('/max/webhook', { schema: { body: z.object({ update_type: z.string(), timestamp: z.number().optional() }).passthrough(), response: { 200: okSchema, ...errors } } }, async req => {
    if (!equalSecret(String(req.headers['x-max-bot-api-secret'] ?? ''), config.MAX_WEBHOOK_SECRET)) throw new AppError('UNAUTHORIZED', 'Недопустимая подпись webhook', 401);
    if (!botHandler) throw new AppError('MAX_API_ERROR', 'Бот не запущен', 503, true);
    await botHandler(req.body); return { ok: true };
  });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  const webRoot = resolve('apps/web/dist');
  if (existsSync(webRoot)) { await app.register(staticFiles, { root: webRoot }); app.setNotFoundHandler((req, reply) => req.url.startsWith('/api') || req.url.startsWith('/max') ? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Адрес не найден', retryable: false } }) : reply.sendFile('index.html')); }
  return { app, service, setBotHandler: (handler: (update: any) => Promise<void>) => { botHandler = handler; } };
}


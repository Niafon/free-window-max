import { readConfig } from './config.js';
import { createDatabase, migrate, cleanup } from './db/index.js';
import { buildApp } from './app.js';
import { createBot } from './max/bot.js';
const config = readConfig();
const database = createDatabase(config.DATABASE_URL);
await migrate(database); await cleanup(database);
const { app, service, setBotHandler } = await buildApp(config, database);
const integration = config.BOT_TOKEN ? createBot(service, config) : undefined;
if (integration) setBotHandler(integration.process);
await app.listen({ port: config.PORT, host: config.HOST });
if (integration && config.MAX_MODE === 'polling') {
  integration.bot.catch(() => app.log.error({ code: 'MAX_API_ERROR' }, 'Bot update failed'));
  void integration.bot.start({ mode: 'polling', options: { allowedUpdates: ['bot_started', 'message_created', 'message_callback'], retry: true } }).catch(() => app.log.error({ code: 'MAX_API_ERROR' }, 'Polling unavailable'));
}
const timer = setInterval(() => void cleanup(database).catch(() => app.log.error({ code: 'CLEANUP_ERROR' })), 3600000); timer.unref();
const followups = integration ? setInterval(() => void integration.followups().catch(() => app.log.error({ code: 'MAX_API_ERROR' }, 'Follow-up delivery failed')), 60000) : undefined; followups?.unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { clearInterval(timer); clearInterval(followups); integration?.bot.stopPolling(); await app.close(); await database.pool.end(); process.exit(0); });

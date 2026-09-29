import { Bot } from '@maxhub/max-bot-api';
import { readConfig } from '../apps/api/src/config.js';
const c = readConfig();
if (!c.BOT_TOKEN || c.MAX_WEBHOOK_SECRET.length < 32 || !c.PUBLIC_URL.startsWith('https://')) throw new Error('HTTPS, BOT_TOKEN and MAX_WEBHOOK_SECRET (32+ chars) are required');
const bot = new Bot(c.BOT_TOKEN, { clientOptions: { baseUrl: c.MAX_API_URL } });
try { await bot.api.subscribe(`${c.PUBLIC_URL}/max/webhook`, c.MAX_WEBHOOK_SECRET, ['bot_started', 'message_created', 'message_callback']); console.log('Webhook registered: ' + c.PUBLIC_URL + '/max/webhook'); } catch { console.error('Webhook registration failed. Secrets were not logged.'); process.exitCode = 1; }

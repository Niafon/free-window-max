import { Bot } from '@maxhub/max-bot-api';
import { readConfig } from '../apps/api/src/config.js';
const c = readConfig();
if (!c.BOT_TOKEN) throw new Error('BOT_TOKEN is required');
const bot = new Bot(c.BOT_TOKEN, { clientOptions: { baseUrl: c.MAX_API_URL } });
try { const me = await bot.api.getMyInfo(); console.log(JSON.stringify({ userId: me.user_id, username: me.username, url: `https://max.ru/${me.username}`, subscriptions: (await bot.api.getSubscriptions()).map(s => ({ url: s.url })) }, null, 2)); } catch { console.error('MAX connection failed. Check token, API host and trusted TLS certificate. Token was not logged.'); process.exitCode = 1; }

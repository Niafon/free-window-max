// Screenshots of a real search (KudaGo events with their photos + Yandex routes) for README and the deck.
// Runs against a deployed instance that has YANDEX_MAPS_KEY: SCREENSHOT_URL=https://… node scripts/screenshots.mjs
// One search spends at most ~20 route requests of the daily quota; the mobile pass reuses the cached routes.
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const base = process.env.SCREENSHOT_URL ?? 'https://77-91-95-175.sslip.io';
const out = process.env.SCREENSHOT_DIR ?? 'docs/assets';
mkdirSync(out, { recursive: true });
// The server deploys itself a few minutes after main goes green; wait until it serves the guest-access build.
for (let attempt = 0; ; attempt++) {
  const config = await fetch(`${base}/api/v1/config`).then(r => r.json()).catch(() => ({}));
  if ('guestAuth' in config) { if (!config.liveAvailable) throw new Error('YANDEX_MAPS_KEY is not configured on this server'); break; }
  if (attempt >= 60) throw new Error('Server is not running the guest-access build yet');
  await new Promise(r => setTimeout(r, 20000));
}
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function search(page) {
  await page.goto(base);
  const find = page.getByRole('button', { name: 'Найти варианты', exact: true });
  await find.waitFor({ timeout: 30000 }); await page.waitForTimeout(500);
  // Test data is the default; switch to real events the way a user does.
  const live = page.getByRole('button', { name: 'Перейти к реальным событиям' });
  if (await live.count()) await live.click();
  else if (!(await page.locator('.mode-badge.live').count())) throw new Error('Real data is not enabled on this server');
  await page.locator('.mode-badge.live').waitFor();
  // A wide evening window and generous limits so the deck shows several real events, not one.
  await page.getByRole('combobox', { name: 'Свободен с' }).selectOption('17:30');
  await page.getByRole('combobox', { name: 'Свободен до' }).selectOption('22:30');
  await page.getByRole('spinbutton', { name: 'Бюджет на человека' }).fill('3000');
  await page.getByRole('spinbutton', { name: 'Лимит дороги' }).fill('60');
  await find.click();
  const done = page.getByRole('heading', { name: /помеща(ю|е)тся в окно/ });
  await Promise.race([done.waitFor({ timeout: 90000 }), page.locator('.error').waitFor({ timeout: 90000 }).then(async () => { throw new Error(await page.locator('.error').innerText()); })]);
  // Let photos load before capturing.
  await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1500);
  const toast = page.locator('.toast'); if (await toast.count()) await toast.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
}
const desktop = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })).newPage();
await search(desktop);
await desktop.locator('.results').screenshot({ path: `${out}/real-results.png` });
await desktop.locator('.event-card .card-title').first().click();
await desktop.locator('dialog .detail-body').waitFor(); await desktop.waitForTimeout(1200);
await desktop.screenshot({ path: `${out}/real-detail.png` });
const mobile = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
await search(mobile);
await mobile.locator('.event-card').first().evaluate(e => e.scrollIntoView({ block: 'start' })); await mobile.waitForTimeout(800);
await mobile.screenshot({ path: `${out}/real-mobile.png` });
console.log('Titles:', await desktop.locator('.event-card .card-title').allInnerTexts());
await browser.close();

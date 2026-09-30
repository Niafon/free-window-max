import { test, expect, type Page } from '@playwright/test';
// No login form: outside MAX a guest session is created automatically. Labelled test data is the default; real events are one switch away.
async function open(page: Page) { await page.goto('/'); await expect(page.getByRole('button', { name: 'Найти варианты', exact: true })).toBeEnabled(); }
test('Одиночный поиск, карточка, выбор, оценка и состояния', async ({ page }, info) => {
  const exceptions: string[] = []; page.on('pageerror', e => exceptions.push(e.message));
  await open(page);
  await expect(page.getByRole('textbox', { name: 'Твоё имя' })).toHaveCount(0);
  await expect(page.locator('.mode-row .mode-badge')).toHaveText('Тестовые данные');
  await expect(page.getByRole('button', { name: 'Перейти к реальным событиям' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Опиши вечер одной фразой' }).fill('до 1000, не дальше 30 минут, игры');
  await page.getByRole('button', { name: 'Заполнить' }).click(); await expect(page.getByRole('status')).toContainText('Заполнил');
  await expect(page.getByRole('spinbutton', { name: 'Бюджет на человека' })).toHaveValue('1000');
  await page.getByRole('button', { name: 'Найти варианты', exact: true }).click();
  await expect(page.getByRole('heading', { name: /помеща(ю|е)тся в окно/ })).toBeVisible();
  await expect(page.locator('.event-card .window-timeline').first()).toBeVisible();
  // «игры» from the phrase is a filter: other categories are not offered.
  await expect(page.getByRole('button', { name: 'Подробнее: Вечер настольных игр' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Подробнее: Прогулка без спешки' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Карта' }).click(); await expect(page.locator('.results-map .map-pin').first()).toBeVisible(); await page.getByRole('tab', { name: 'Список' }).click();
  await page.screenshot({ path: `test-results/${info.project.name}-results.png`, fullPage: true });
  await page.getByRole('button', { name: 'Подробнее: Вечер настольных игр' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Выбрать план', exact: true }).click();
  await expect(page.getByText('План сохранён', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Нравится', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('оценка сохранена');
  await page.getByRole('button', { name: 'Закрыть карточку' }).click();
  await page.getByRole('spinbutton', { name: 'Лимит дороги' }).fill('5');
  await page.getByRole('button', { name: 'Найти варианты', exact: true }).click();
  await expect(page.getByText('Сейчас ни один вариант не проходит все условия')).toBeVisible();
  await expect(page.locator('.empty-state .chip').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(exceptions).toEqual([]);
});
test('Два пользователя проходят совместное планирование', async ({ page, browser }) => {
  await open(page);
  await page.getByRole('button', { name: 'С друзьями', exact: true }).click();
  await page.getByRole('button', { name: 'Создать компанию' }).click();
  await expect(page.locator('.members').getByText(/^Гость \d{4} \(ты\)/)).toBeVisible();
  const request = page.waitForResponse(r => r.url().includes('/preferences') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Сохранить мои параметры' }).click();
  const session = (await (await request).json());
  const friendContext = await browser.newContext(); const friend = await friendContext.newPage();
  await open(friend); await friend.goto(`/?session=${session.id}`);
  await friend.getByRole('button', { name: 'Присоединиться', exact: true }).click();
  await friend.getByRole('spinbutton', { name: 'Бюджет на человека' }).fill('500');
  await friend.getByRole('button', { name: 'Сохранить мои параметры' }).click();
  await expect(page.locator('.members > div')).toHaveCount(2, { timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Найти общее окно' })).toBeEnabled({ timeout: 10000 });
  await expect(page.locator('.group-windows')).toContainText('Общее окно');
  await page.getByRole('button', { name: 'Найти общее окно' }).click();
  await expect(page.getByRole('heading', { name: /помеща(ю|е)тся в окно/ })).toBeVisible();
  await page.locator('.choose').first().click(); await page.getByRole('button', { name: 'Закрыть карточку' }).click();
  await expect(page.getByText(/Общий вариант выбран/)).toBeVisible();
  await friendContext.close();
});

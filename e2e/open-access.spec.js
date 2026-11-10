import { test, expect } from '@playwright/test';

test('open admin and remembered roster selection preserve separate tester progress', async ({ browser, baseURL }) => {
 const context = await browser.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
 const isolated = await browser.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
 const errors = [];
 const page = await context.newPage();
 page.on('pageerror', e => errors.push(e.message));
 try {
  const suffix = Date.now().toString(36);
  const api = async (path, method = 'GET', data) => {
   const response = await context.request.fetch(path, { method, data });
   expect(response.ok(), await response.text()).toBe(true);
   return response.json();
  };
  await page.goto('/admin#roster');
  await expect(page.getByRole('heading', { name: 'Roster', exact: true })).toBeVisible();
  await expect(page.getByText('Open access — identities are not verified.', { exact: true })).toBeVisible();
  const firstEmail = `open-a-${suffix}@example.com`, secondEmail = `open-b-${suffix}@example.com`;
  await api('/api/admin/members', 'POST', { email: firstEmail, display_name: `First ${suffix}` });
  await api('/api/admin/members', 'POST', { email: secondEmail, display_name: `Second ${suffix}` });
  const { id: release } = await api('/api/admin/releases', 'POST', { from: 'blank', label: `Open ${suffix}` });
  await api(`/api/admin/releases/${release}/publish`, 'POST', {});
  const { id: campaign } = await api('/api/admin/campaigns', 'POST', { name: `Open ${suffix}`, release_id: release, starts_on: '2026-01-01', tz: 'UTC' });
  await api(`/api/admin/campaigns/${campaign}/invites`, 'PUT', { invites: [{ email: firstEmail, roles: ['tester'] }, { email: secondEmail, roles: ['tester'] }] });
  const roster = await api('/api/participants');
  const firstId = roster.participants.find(p => p.label === `First ${suffix}`).id;
  const secondId = roster.participants.find(p => p.label === `Second ${suffix}`).id;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Choose a tester', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Tester', exact: true }).selectOption(firstId);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: `Open ${suffix}`, exact: true }) });
  await card.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page).toHaveURL(/#run=/);
  const run = page.url().split('#run=')[1];
  await page.locator('[data-step="S1-1"]').getByRole('button', { name: /Passed/ }).click();
  await expect(page.locator('#saveState')).toHaveText('All changes saved');
  await page.reload();
  await expect(page.locator('[data-step="S1-1"]').getByRole('button', { name: /Passed/ })).toHaveAttribute('aria-pressed', 'true');
  const second = await isolated.newPage();
  await second.goto('/');
  await expect(second.getByRole('heading', { name: 'Choose a tester', exact: true })).toBeVisible();
  await second.getByRole('combobox', { name: 'Tester', exact: true }).selectOption(secondId);
  await second.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(second.locator('section.card').filter({ hasText: `Open ${suffix}` }).getByRole('button', { name: 'Start', exact: true })).toBeVisible();

  const stale = await context.newPage();
  await stale.goto(`/#run=${run}`);
  await expect(stale.locator('[data-step="S1-1"]')).toBeVisible();
  await page.getByRole('button', { name: 'Change tester', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose a tester', exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.getByRole('combobox', { name: 'Tester', exact: true }).selectOption(secondId);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const rejected = stale.waitForResponse(r => r.url().endsWith('/results/S1-1') && r.request().method() === 'PUT');
  await stale.locator('[data-step="S1-1"]').getByRole('button', { name: /Passed/ }).click();
  expect((await rejected).status()).toBe(409);
  await expect(stale.getByText(/tester changed in another tab/)).toBeVisible();
  const previous = await context.request.get(`/api/admin/runs/${run}`);
  expect((await previous.json()).results[0].status).toBe('pass');
  await page.goto(`/#run=${run}`);
  await expect(page.getByText(/This run belongs to another tester/)).toBeVisible();
  await expect(page.getByRole('button', { name: /All campaigns/ })).toBeVisible();
  expect(errors).toEqual([]);
 } finally { await context.close(); await isolated.close(); }
});

test('empty open roster points to admin without asking anyone to sign in', async ({ page }) => {
 await page.route('**/api/participants', async route => {
  const response = await route.fetch();
  const data = await response.json();
  await route.fulfill({ json: { ...data, participants: [], selectedId: null } });
 });
 await page.goto('/');
 await expect(page.getByRole('heading', { name: 'Choose a tester', exact: true })).toBeVisible();
 await expect(page.getByText('No active testers are available yet.', { exact: true })).toBeVisible();
 await expect(page.getByRole('link', { name: /Add testers in Admin/ })).toHaveAttribute('href', '/admin#roster');
});

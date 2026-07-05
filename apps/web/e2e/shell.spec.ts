import { expect, test } from '@playwright/test';

test.describe('application shell', () => {
  test('renders the dashboard with honest empty states', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
    // Dashboard areas exist and are explicit about having no data.
    await expect(page.getByText('No trending topics yet')).toBeVisible();
    await expect(page.getByText('No active research')).toBeVisible();
    // No fabricated analytics anywhere.
    await expect(page.getByText('Phase 1 foundation')).toBeVisible();
  });

  test('primary navigation reaches research and trends', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Research' })).toBeVisible();

    await nav.getByRole('link', { name: 'Research' }).click();
    await expect(page).toHaveURL(/\/research$/);
    await expect(page.getByRole('heading', { name: 'Research', exact: true })).toBeVisible();
    await expect(page.getByText('No research projects yet')).toBeVisible();

    await nav.getByRole('link', { name: 'Trends', exact: true }).click();
    await expect(page).toHaveURL(/\/trends$/);
    await expect(page.getByText('No trends detected yet')).toBeVisible();
  });

  test('unknown routes show the not-found page', async ({ page }) => {
    const response = await page.goto('/this-route-does-not-exist');
    expect(response?.status()).toBe(404);
    await expect(page.getByText('Page not found')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to Home' })).toBeVisible();
  });

  test('navigation is keyboard accessible', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(['A', 'BUTTON', 'INPUT']).toContain(focused ?? '');
  });
});

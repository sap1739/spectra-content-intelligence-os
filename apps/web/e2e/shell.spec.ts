import { expect, test } from '@playwright/test';

/**
 * Shell smoke tests against the production build WITHOUT a running API:
 * unauthenticated visitors must land on /login. Authenticated journeys are
 * covered by API integration tests (and a full-stack e2e suite once the
 * research pipeline lands).
 */
test.describe('unauthenticated shell', () => {
  test('visiting the app redirects to the login page', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
  });

  test('login validates input client-side before hitting the API', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(/invalid email/i).first()).toBeVisible();
  });

  test('register page is reachable and explains password policy', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Create an account' }).click();
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    await expect(page.getByText('At least 12 characters.')).toBeVisible();
  });

  test('unknown routes show the not-found page', async ({ page }) => {
    const response = await page.goto('/this-route-does-not-exist');
    expect(response?.status()).toBe(404);
    await expect(page.getByText('Page not found')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to Home' })).toBeVisible();
  });

  test('login form is keyboard accessible', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').focus();
    await page.keyboard.type('user@example.test');
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.id);
    expect(focused).toBe('password');
  });
});

import { test, expect } from '@playwright/test';

test.describe('Warehouse Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/warehouse');
  });

  test('page loads and shows portfolio bar', async ({ page }) => {
    // Portfolio bar shows object count and document count
    await expect(page.getByText('Objekte')).toBeVisible();
    await expect(page.getByText('Dokumente').first()).toBeVisible();
  });

  test('property cards are visible with document counts', async ({ page }) => {
    // The "Immobilien" heading is present
    await expect(page.getByRole('heading', { name: 'Immobilien' })).toBeVisible();

    // At least one property card with a document count footer
    const cards = page.locator('.grid .cursor-pointer');
    await expect(cards.first()).toBeVisible();
    await expect(cards.first().getByText(/\d+ Dokumente/)).toBeVisible();
  });

  test('clicking a property card navigates to property detail', async ({ page }) => {
    const firstCard = page.locator('.grid .cursor-pointer').first();
    await firstCard.click();

    // URL should include the property UUID
    await expect(page).toHaveURL(/\/dashboard\/warehouse\/[a-f0-9-]+/);
  });

  test('inbox link shows badge count', async ({ page }) => {
    // Sidenav inbox link
    const inboxLink = page.getByRole('link', { name: /Inbox/ });
    await expect(inboxLink).toBeVisible();

    // Badge with count (if there are items to review)
    const badge = inboxLink.locator('span.rounded-full');
    const badgeCount = await badge.count();
    if (badgeCount > 0) {
      await expect(badge.first()).toBeVisible();
    }
  });
});

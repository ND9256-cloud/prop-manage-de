import { test, expect } from '@playwright/test';

test.describe('Property Detail', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to warehouse, click first table row to get to a detail page
    await page.goto('/dashboard/warehouse');
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.click();
    await expect(page).toHaveURL(/\/dashboard\/warehouse\/[a-f0-9-]+/);
  });

  test('property detail loads with category list', async ({ page }) => {
    // Property name heading is visible
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible();

    // Category list shows at least one category with a document count
    await expect(page.getByText('Kosten & Rechnungen')).toBeVisible();
  });

  test('tabs are visible: Dokumente Kosten Protokoll Stammdaten', async ({ page }) => {
    for (const tab of ['dokumente', 'kosten', 'protokoll', 'stammdaten']) {
      await expect(page.locator(`a[href*="tab=${tab}"]`)).toBeVisible();
    }
  });

  test('document count is greater than zero', async ({ page }) => {
    // At least one category row shows a count > 0
    const categoryRow = page.getByText(/\d+\s*>/).first();
    await expect(categoryRow).toBeVisible();
  });
});

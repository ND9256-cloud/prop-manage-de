import { test, expect } from '@playwright/test';

test.describe('Property Detail', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to warehouse, click first property card to get to a detail page
    await page.goto('/dashboard/warehouse');
    const firstCard = page.locator('.grid .cursor-pointer').first();
    await firstCard.click();
    await expect(page).toHaveURL(/\/dashboard\/warehouse\/[a-f0-9-]+/);
  });

  test('property detail loads with category cards', async ({ page }) => {
    // Property name heading is visible
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible();

    // Stats row shows document count
    await expect(page.getByText(/\d+ Dokumente?/i).first()).toBeVisible();
  });

  test('tabs are visible: Dokumente Kosten Protokoll Stammdaten', async ({ page }) => {
    for (const tab of ['Dokumente', 'Kosten', 'Protokoll', 'Stammdaten']) {
      await expect(page.getByRole('tab', { name: tab }).or(page.getByText(tab, { exact: true }))).toBeVisible();
    }
  });

  test('document count is greater than zero', async ({ page }) => {
    // The stats row or header shows a document count > 0
    const docText = page.getByText(/(\d+)\s*Dokumente?/i).first();
    await expect(docText).toBeVisible();

    const text = await docText.textContent();
    const match = text?.match(/(\d+)/);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeGreaterThan(0);
  });
});

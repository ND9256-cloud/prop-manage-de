import { test, expect } from '@playwright/test';

test.describe('Inbox', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/warehouse/inbox');
  });

  test('page loads and shows document list', async ({ page }) => {
    // Header is visible
    await expect(page.getByRole('heading', { name: 'Alle Dokumente' })).toBeVisible();

    // Stats line shows document count
    await expect(page.getByText(/\d+ Dokumente/).first()).toBeVisible();

    // Table has at least one document row
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
  });

  test('filter by status works', async ({ page }) => {
    // Open status filter dropdown and select "needs_review"
    const statusFilter = page.getByRole('combobox').filter({ hasText: /Status/ });
    await statusFilter.click();
    await page.getByRole('option', { name: /needs_review|Prüfung/i }).click();

    // Table should still be visible (may have fewer rows)
    await expect(page.locator('table')).toBeVisible();

    // URL should reflect the filter
    await expect(page).toHaveURL(/status=needs_review/);
  });

  test('document rows show category and date', async ({ page }) => {
    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow).toBeVisible();

    // Each row should have cells — category and date are present
    const cells = firstRow.locator('td');
    const cellCount = await cells.count();
    expect(cellCount).toBeGreaterThanOrEqual(5);

    // Date column should contain a formatted date (dd.mm.yyyy pattern)
    await expect(page.locator('td').getByText(/\d{1,2}\.\d{1,2}\.\d{4}/).first()).toBeVisible();
  });
});

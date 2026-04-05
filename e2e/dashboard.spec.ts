import { test, expect } from '@playwright/test';

test.describe('Warehouse Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/warehouse');
  });

  test('page loads and shows portfolio KPI strip', async ({ page }) => {
    // Portfolio KPI strip shows Objekte and Einheiten
    await expect(page.getByText('Objekte', { exact: true })).toBeVisible();
    await expect(page.getByText('Einheiten', { exact: true }).first()).toBeVisible();
  });

  test('holdings table is visible with properties', async ({ page }) => {
    // The "Immobilien" heading is present (exact to avoid matching "Immobilien-Analyse")
    await expect(page.getByRole('heading', { name: 'Immobilien', exact: true })).toBeVisible();

    // At least one row in the holdings table
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
  });

  test('clicking a table row navigates to property detail', async ({ page }) => {
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.click();

    // URL should include the property UUID
    await expect(page).toHaveURL(/\/dashboard\/warehouse\/[a-f0-9-]+/);
  });

  test('sidebar shows Alle Dokumente link', async ({ page }) => {
    // Sidenav documents link
    const docsLink = page.getByRole('link', { name: /Alle Dokumente/ });
    await expect(docsLink).toBeVisible();
  });
});

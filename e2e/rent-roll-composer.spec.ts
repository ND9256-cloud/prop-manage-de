import { test, expect } from '@playwright/test';

test.describe('Composer rent roll (Task 3.3)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/warehouse');
  });

  test('warehouse-properties-loaded testid is present (monitoring invariant)', async ({ page }) => {
    await expect(page.locator('[data-testid="warehouse-properties-loaded"]')).toBeVisible();
  });

  test('composer rent roll renders Lena €650 for KO132 1.OG', async ({ page }) => {
    const rentRoll = page.locator('[data-testid="rent-roll-composer"]');
    await expect(rentRoll).toBeVisible();

    // The default property is KO132 — 1.OG should expose its kaltmiete cell
    const lenaCell = page.locator('[data-testid="kaltmiete-1.OG"]');
    await expect(lenaCell).toBeVisible();
    await expect(lenaCell).toContainText('650');
  });

  test('clicking Lena €650 opens the provenance modal showing the source Mietvertrag', async ({ page }) => {
    await page.locator('[data-testid="kaltmiete-1.OG"]').click();

    const modal = page.locator('[data-testid="provenance-modal"]');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Beleg');
    await expect(modal).toContainText('Kaltmiete');

    // At least one source document linked
    const docs = modal.locator('[data-testid="provenance-documents"] li');
    await expect(docs.first()).toBeVisible();
  });

  test('KO132 EG renders phantom-vacancy upload CTA', async ({ page }) => {
    const eg = page.locator('tr[data-unit-ref="EG"]');
    await expect(eg).toBeVisible();
    await expect(eg).toContainText('Kein Mietvertrag hinterlegt');

    const cta = eg.locator('[data-action="upload-lease"]');
    await expect(cta).toHaveCount(1);
  });

  test('Vermietungsquote is rendered as an understated header stat', async ({ page }) => {
    const stat = page.locator('[data-testid="vermietungsquote-stat"]');
    await expect(stat).toBeVisible();
    await expect(stat).toContainText('%');
  });
});

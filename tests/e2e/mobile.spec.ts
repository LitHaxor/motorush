import { test, expect } from '@playwright/test';
import { gotoGame, startRace, worldState } from './helpers';

// Runs only under the `mobile` project (Pixel 5) - see playwright.config.ts.
test.describe('mobile', () => {
  test('touch controls appear on a touch device', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 15 });
    await expect(page.locator('#touch-controls')).toBeVisible();
    await expect(page.locator('[data-touch="throttle"]')).toBeVisible();
    await expect(page.locator('[data-touch="attack-left"]')).toBeVisible();
  });

  test('the gas button accelerates', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 16 });
    const gas = page.locator('[data-touch="throttle"]');
    const before = (await worldState(page)).speed;
    await gas.dispatchEvent('pointerdown');
    await page.waitForFunction((v) => window.roadbrush!.world()!.player.speed > v + 1, before);
    await gas.dispatchEvent('pointerup');
    const after = (await worldState(page)).speed;
    expect(after).toBeGreaterThan(before);
  });

  test('the splash fits a phone screen without horizontal scroll', async ({ page }) => {
    await gotoGame(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByRole('button', { name: /twist the throttle/i })).toBeVisible();
  });
});

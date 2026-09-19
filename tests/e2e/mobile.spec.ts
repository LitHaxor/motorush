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
    await page.waitForFunction((v) => window.motorush!.world()!.player.speed > v + 1, before);
    await gas.dispatchEvent('pointerup');
    const after = (await worldState(page)).speed;
    expect(after).toBeGreaterThan(before);
  });

  test('the punch buttons throw a punch', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 17 });
    const punch = page.locator('[data-touch="attack-right"]');
    await punch.dispatchEvent('pointerdown');
    await punch.dispatchEvent('pointerup');
    // The swing is queued on press and started on the next simulated step.
    await page.waitForFunction(() => window.motorush!.world()!.localRacer.attackTimer > 0);
    expect((await worldState(page)).state).toBe('racing');
  });

  test('a thumb rolling from one steering button to the other keeps steering', async ({ page }) => {
    // Both buttons drive one axis. Releasing the second used to centre the
    // steering even though the first was still held, which on a phone reads
    // as the controls dying mid-corner.
    await gotoGame(page);
    await startRace(page, { seed: 18 });
    const left = page.locator('[data-touch="left"]');
    const right = page.locator('[data-touch="right"]');

    await left.dispatchEvent('pointerdown');
    await right.dispatchEvent('pointerdown');
    await right.dispatchEvent('pointerup');

    const steer = await page.evaluate(() => window.motorush!.input().steer);
    expect(steer).toBeLessThan(0); // still turning left

    await left.dispatchEvent('pointerup');
    expect(await page.evaluate(() => window.motorush!.input().steer)).toBe(0);
  });

  test('there is a way to pause without a keyboard', async ({ page }) => {
    // A phone has no Escape key, so a race that went wrong could not even be
    // quit - the only way out was to reload the page.
    await gotoGame(page);
    await startRace(page, { seed: 19 });
    await expect(page.locator('#btn-pause')).toBeVisible();
    await page.locator('#btn-pause').click();
    await expect(page.locator('#screen-pause')).toBeVisible();
    await page.locator('#btn-resume').click();
    await page.waitForFunction(() => window.motorush!.mode() === 'racing');
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

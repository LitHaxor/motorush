import { test, expect } from '@playwright/test';
import { gotoGame } from './helpers';

test.describe('boot and menu', () => {
  test('loads, initialises WebGL and shows the splash', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));

    await gotoGame(page);

    await expect(page).toHaveTitle(/MotoRush/i);
    await expect(page.locator('#screen-splash')).toBeVisible();
    await expect(page.getByRole('button', { name: /twist the throttle/i })).toBeVisible();
    // HUD stays out of the way until a race starts.
    await expect(page.locator('#hud')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('renders an actual 3D frame, not a blank canvas', async ({ page }) => {
    await gotoGame(page);
    const info = await page.evaluate(() => {
      const canvas = document.getElementById('stage') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      return { width: canvas.width, height: canvas.height, hasContext: !!gl };
    });
    expect(info.hasContext).toBe(true);
    expect(info.width).toBeGreaterThan(0);
    expect(info.height).toBeGreaterThan(0);

    // A screenshot of the live scene must not be a single flat colour.
    const shot = await page.locator('#stage').screenshot();
    expect(shot.byteLength).toBeGreaterThan(5000);
  });

  test('ground textures and props are served', async ({ page }) => {
    const failed: string[] = [];
    page.on('response', (r) => {
      if (/\/(textures|models)\//.test(r.url()) && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
    });
    await gotoGame(page);
    expect(failed).toEqual([]);
  });

  test('difficulty can be chosen before starting', async ({ page }) => {
    await gotoGame(page);
    await page.getByRole('radio', { name: 'OUTLAW' }).click();
    await expect(page.getByRole('radio', { name: 'OUTLAW' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'RASHER' })).toHaveAttribute('aria-checked', 'false');
  });

  test('controls panel toggles', async ({ page }) => {
    await gotoGame(page);
    await expect(page.locator('#controls-card')).toBeHidden();
    await page.getByRole('button', { name: /^controls$/i }).click();
    await expect(page.locator('#controls-card')).toBeVisible();
    await expect(page.getByText(/punch left \/ right/i)).toBeVisible();
  });
});

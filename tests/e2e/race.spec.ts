import { test, expect } from '@playwright/test';
import { gotoGame, startRace, worldState } from './helpers';

test.describe('racing', () => {
  test('starting a race from the menu shows the HUD and runs the countdown', async ({ page }) => {
    await gotoGame(page);
    await page.fill('#rider-name', 'CLAUDE');
    await page.getByRole('button', { name: /twist the throttle/i }).click();

    await page.waitForFunction(() => window.roadbrush?.mode() === 'racing', null, { timeout: 20_000 });
    await expect(page.locator('#hud')).toBeVisible();
    await expect(page.locator('#screen-splash')).toBeHidden();

    // The name carries into the race.
    const name = await page.evaluate(() => window.roadbrush!.world()!.player.name);
    expect(name).toBe('CLAUDE');

    // Countdown first, then green.
    expect((await worldState(page)).state).toBe('countdown');
    await page.evaluate(() => window.roadbrush!.fastForward(4));
    expect((await worldState(page)).state).toBe('racing');
  });

  test('eight riders line up and the player makes progress', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 4242 });

    const before = await worldState(page);
    expect(before.racers).toBe(8);
    expect(before.distance).toBeLessThan(50);

    await page.evaluate(() => window.roadbrush!.fastForward(8, { throttle: 1 }));
    const after = await worldState(page);
    expect(after.distance).toBeGreaterThan(before.distance + 100);
    expect(after.elapsed).toBeGreaterThan(before.elapsed);
  });

  test('HUD reflects speed, position and distance', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 99 });
    await page.evaluate(() => window.roadbrush!.fastForward(6, { throttle: 1 }));
    // Wait for a render frame to push the values into the DOM, however long
    // that takes on a software renderer.
    await page.waitForFunction(() => Number(document.getElementById('hud-speed')!.textContent) > 0);

    const speed = Number(await page.locator('#hud-speed').innerText());
    const distance = Number(await page.locator('#hud-distance').innerText());
    expect(speed).toBeGreaterThan(0);
    expect(distance).toBeGreaterThan(0);
    await expect(page.locator('#hud-place')).toHaveText(/\d+(ST|ND|RD|TH)/);
    await expect(page.locator('#hud-timer')).toHaveText(/\d:\d\d\.\d\d\d/);
  });

  test('pause halts the clock and resume continues it', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 7 });
    await page.evaluate(() => window.roadbrush!.fastForward(3, { throttle: 1 }));

    await page.keyboard.press('Escape');
    await expect(page.locator('#screen-pause')).toBeVisible();
    expect(await page.evaluate(() => window.roadbrush!.mode())).toBe('paused');

    const paused = await worldState(page);
    await page.waitForTimeout(600);
    const stillPaused = await worldState(page);
    expect(stillPaused.elapsed).toBeCloseTo(paused.elapsed, 5);

    await page.getByRole('button', { name: /^resume$/i }).click();
    await expect(page.locator('#screen-pause')).toBeHidden();
    expect(await page.evaluate(() => window.roadbrush!.mode())).toBe('racing');
  });

  test('quitting from pause returns to the menu', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 7 });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /quit to menu/i }).click();
    await expect(page.locator('#screen-splash')).toBeVisible();
    await expect(page.locator('#hud')).toBeHidden();
    expect(await page.evaluate(() => window.roadbrush!.mode())).toBe('menu');
  });

  test('the same seed builds the same race', async ({ page }) => {
    // The browser loop advances in real time alongside any scripted stepping,
    // so distance travelled cannot be compared exactly here - that invariant is
    // covered by the headless determinism unit test. What must hold in the
    // browser is that a seed rebuilds an identical world.
    const fingerprint = async (seed: number) => {
      await startRace(page, { seed });
      const fp = await page.evaluate(() => {
        const w = window.roadbrush!.world()!;
        const samples: number[] = [];
        for (let s = 0; s < 4000; s += 250) {
          const pt = w.track.toWorld(s, 0);
          samples.push(+pt.x.toFixed(4), +pt.z.toFixed(4));
        }
        return {
          samples,
          rivals: w.rivals.map((r: { name: string }) => r.name),
          pickups: w.pickups.length,
          raceDistance: w.raceDistance,
        };
      });
      await page.evaluate(() => window.roadbrush!.quit());
      return fp;
    };

    await gotoGame(page);
    const a = await fingerprint(31337);
    const b = await fingerprint(31337);
    const c = await fingerprint(31338);

    expect(b).toEqual(a);
    expect(c.samples).not.toEqual(a.samples);
  });
});

import { test, expect } from '@playwright/test';
import { gotoGame, startRace, worldState } from './helpers';

test.describe('controls', () => {
  test('keyboard throttle accelerates the bike', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 12 });

    const before = (await worldState(page)).speed;
    await page.keyboard.down('KeyW');
    await page.waitForFunction((v) => window.roadbrush!.world()!.player.speed > v + 1, before);
    await page.keyboard.up('KeyW');
    const after = (await worldState(page)).speed;
    expect(after).toBeGreaterThan(before);
  });

  test('steering moves the bike across the road', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 13 });

    // Put the rider on a clear straight at speed. Without this the bike can be
    // lying on the tarmac after hitting traffic, and a downed bike does not
    // steer - which would make this test about crash handling, not steering.
    await page.evaluate(() => {
      const w = window.roadbrush!.world()!;
      const p = w.player;
      p.state = 'ride';
      p.downTimer = 0;
      p.health = 100;
      p.s = 30;
      p.lateral = 0;
      p.speed = 45;
      for (const car of w.traffic.cars) car.s = p.s + 400;
    });

    const before = await page.evaluate(() => window.roadbrush!.world()!.player.lateral);

    // Poll for the effect rather than sleeping: headless software WebGL runs
    // the frame loop slowly, so a fixed wait measures framerate, not steering.
    await page.keyboard.down('KeyD');
    await page.waitForFunction(
      (start) => window.roadbrush!.world()!.player.lateral > start + 0.2,
      before,
    );
    await page.keyboard.up('KeyD');

    const after = await page.evaluate(() => ({
      lateral: window.roadbrush!.world()!.player.lateral,
      state: window.roadbrush!.world()!.player.state,
    }));
    expect(after.state).toBe('ride');
    expect(after.lateral).toBeGreaterThan(before);

    // And the other way.
    await page.keyboard.down('KeyA');
    await page.waitForFunction(
      (peak) => window.roadbrush!.world()!.player.lateral < peak - 0.2,
      after.lateral,
    );
    await page.keyboard.up('KeyA');
  });

  test('full lock crosses the road in about a second', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 13 });
    // Deterministic: step the simulation directly instead of racing the clock.
    const moved = await page.evaluate(() => {
      const api = window.roadbrush!;
      const w = api.world()!;
      const p = w.player;
      p.state = 'ride'; p.downTimer = 0; p.s = 30; p.lateral = -4; p.speed = 50;
      for (const car of w.traffic.cars) car.s = p.s + 500;
      const before = p.lateral;
      api.fastForward(1, { throttle: 1, steer: 1 });
      return { before, after: p.lateral, state: p.state };
    });
    expect(moved.state).toBe('ride');
    expect(moved.after - moved.before).toBeGreaterThan(5);
  });

  test('punching a rival costs them health', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 14 });

    const damaged = await page.evaluate(() => {
      const api = window.roadbrush!;
      const w = api.world()!;
      const victim = w.rivals[0];
      victim.state = 'ride';
      victim.health = 100;
      // Pull the victim alongside, on the player's right.
      w.player.s = 300; w.player.lateral = 0; w.player.speed = 40; w.player.state = 'ride';
      victim.s = 300.5; victim.lateral = 2; victim.speed = 40;
      const before = victim.health;
      w.requestAttack(1);
      api.fastForward(0.5, { throttle: 0 });
      return { before, after: victim.health };
    });
    expect(damaged.after).toBeLessThan(damaged.before);
  });

  test('mute button toggles', async ({ page }) => {
    await gotoGame(page);
    const btn = page.locator('#btn-mute');
    await expect(btn).toHaveText('🔊');
    await btn.click();
    await expect(btn).toHaveText('🔇');
    await btn.click();
    await expect(btn).toHaveText('🔊');
  });
});

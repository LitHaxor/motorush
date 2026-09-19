import { test, expect } from '@playwright/test';
import { gotoGame, startRace, worldState } from './helpers';

test.describe('end screens', () => {
  test('crossing the line shows the finish board with full standings', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 555 });

    // Put the player on the line rather than riding the whole 5 km.
    await page.evaluate(() => {
      const w = window.motorush!.world()!;
      w.player.s = w.raceDistance - 4;
    });
    await page.evaluate(() => window.motorush!.fastForward(3, { throttle: 1 }));

    await expect(page.locator('#screen-finish')).toBeVisible();
    await expect(page.locator('#hud')).toBeHidden();
    await expect(page.locator('#finish-stamp')).toHaveText(/\d+(ST|ND|RD|TH)/);
    // Every rider is accounted for on the results board.
    await expect(page.locator('#finish-results li')).toHaveCount(8);
    await expect(page.locator('#finish-results li.is-player')).toHaveCount(1);
    await expect(page.locator('#finish-stats > div')).toHaveCount(4);
    expect((await worldState(page)).state).toBe('finished');
  });

  test('winning shows the first-place treatment', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 556 });
    await page.evaluate(() => {
      const w = window.motorush!.world()!;
      // Player on the line, everyone else left behind.
      w.player.s = w.raceDistance - 3;
      for (const r of w.rivals) r.s = 100;
    });
    await page.evaluate(() => window.motorush!.fastForward(3, { throttle: 1 }));

    await expect(page.locator('#screen-finish')).toBeVisible();
    await expect(page.locator('#finish-stamp')).toHaveText('1ST');
    await expect(page.locator('#finish-stamp')).toHaveClass(/verdict__stamp--win/);
    await expect(page.locator('#finish-blurb')).toContainText(/took the win/i);
  });

  test('running out of health shows WASTED', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 557 });
    await page.evaluate(() => {
      window.motorush!.world()!.player.health = 0;
    });
    await page.evaluate(() => window.motorush!.fastForward(0.5, { throttle: 1 }));

    await expect(page.locator('#screen-wasted')).toBeVisible();
    await expect(page.locator('#screen-wasted .verdict__stamp')).toHaveText('WASTED');
    await expect(page.locator('#wasted-stats > div')).toHaveCount(5);
    expect((await worldState(page)).state).toBe('wasted');
  });

  test('going down with a patrol on you shows BUSTED', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 558 });

    // Send a patrol, then put the rider on the tarmac in front of them. The
    // arrest lands when they pick the bike back up.
    await page.evaluate(() => {
      const api = window.motorush!;
      const w = api.world()!;
      const cop = w.spawnCop();
      // Put a car head-on in front of them: a real crash, through the real
      // collision path, rather than poking the health value. The lane index
      // matters - traffic.step() recomputes `lateral` from it every tick, so
      // setting `lateral` alone would just be overwritten.
      const car = w.traffic.cars[0];
      car.active = true;
      car.dir = -1;
      car.speed = 28;
      car.laneIndex = 2;
      car.lateral = w.player.lateral;
      car.swerve = 0;
      w.player.lateral = 2.25;
      car.s = w.player.s + 6;
      for (let i = 0; i < 80 && api.mode() === 'racing'; i++) {
        cop.s = w.player.s - 6;
        cop.lateral = w.player.lateral + 2;
        api.fastForward(0.1, { throttle: 1 });
      }
    });

    await expect(page.locator('#screen-busted')).toBeVisible();
    await expect(page.locator('#screen-busted .verdict__stamp')).toHaveText('BUSTED');
    await expect(page.locator('#busted-stats > div')).toHaveCount(5);
    expect((await worldState(page)).state).toBe('busted');
  });

  test('staying upright keeps you out of the cells', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 562 });

    await page.evaluate(() => {
      const api = window.motorush!;
      const w = api.world()!;
      const cop = w.spawnCop();
      for (let i = 0; i < 40 && api.mode() === 'racing'; i++) {
        // Clear road, full health, glued alongside: proximity alone is not
        // an arrest.
        for (const car of w.traffic.cars) car.s = w.player.s + 500;
        w.player.lateral = 2;
        w.player.health = w.player.maxHealth;
        cop.s = w.player.s;
        cop.lateral = w.player.lateral + 2;
        api.fastForward(0.1, { throttle: 1 });
      }
    });

    await expect(page.locator('#screen-busted')).toBeHidden();
    expect((await worldState(page)).state).toBe('racing');
  });

  test('the pursuit warning appears while a cop is chasing', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 559 });
    await expect(page.locator('#hud-pursuit')).toBeHidden();

    await page.evaluate(() => {
      const w = window.motorush!.world()!;
      w.spawnCop();
    });
    await page.evaluate(() => window.motorush!.fastForward(0.4, { throttle: 1 }));
    await page.waitForTimeout(250);
    await expect(page.locator('#hud-pursuit')).toBeVisible();
    await expect(page.locator('.pursuit__title')).toContainText(/highway patrol/i);
  });

  test('ride again starts a fresh race from an end screen', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 560 });
    await page.evaluate(() => {
      window.motorush!.world()!.player.health = 0;
    });
    await page.evaluate(() => window.motorush!.fastForward(0.5, { throttle: 1 }));
    await expect(page.locator('#screen-wasted')).toBeVisible();

    await page.locator('#screen-wasted').getByRole('button', { name: /ride again/i }).click();
    await page.waitForFunction(() => window.motorush?.mode() === 'racing', null, { timeout: 20_000 });
    await expect(page.locator('#screen-wasted')).toBeHidden();
    await expect(page.locator('#hud')).toBeVisible();
    const s = await worldState(page);
    expect(s.health).toBeGreaterThan(0);
    expect(s.distance).toBeLessThan(50);
  });

  test('main menu button returns from an end screen', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 561 });
    await page.evaluate(() => {
      window.motorush!.world()!.player.health = 0;
    });
    await page.evaluate(() => window.motorush!.fastForward(0.5, { throttle: 1 }));
    await page.locator('#screen-wasted').getByRole('button', { name: /main menu/i }).click();
    await expect(page.locator('#screen-splash')).toBeVisible();
  });
});

test.describe('the board after you finish', () => {
  test('keeps showing the riders still out there, then brings them home', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 4242 });

    // Cross the line well clear of the field, which is the case that used to
    // leave the rest of the grid frozen and marked DNF the instant you won.
    await page.evaluate(() => {
      const w = window.motorush!.world()!;
      w.localRacer.s = w.raceDistance - 3;
      for (const r of w.rivals) r.s = w.raceDistance - 400;
    });
    await page.evaluate(() => window.motorush!.fastForward(3, { throttle: 1 }));

    await expect(page.locator('#screen-finish')).toBeVisible();
    await expect(page.locator('#finish-stamp')).toHaveText('1ST');
    // Nobody is a DNF while they are still riding: the board says how much
    // road each of them has left instead.
    await expect(page.locator('#finish-note')).toContainText(/STILL ON/i);
    await expect(page.locator('#finish-results li').last()).not.toContainText('DNF');

    // And the places behind you are settled by riding, not by the clock
    // stopping: every rider gets home and the board says so.
    await expect(page.locator('#finish-note')).toContainText(/EVERY RIDER IS IN/i, {
      timeout: 40_000,
    });
    await expect(page.locator('#finish-results li')).toHaveCount(8);
    await expect(page.locator('#finish-results li:has-text("DNF")')).toHaveCount(0);
  });

  test('puts the highlight on your own row', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 4243, riderName: 'HASAN' });
    await page.evaluate(() => {
      const w = window.motorush!.world()!;
      w.localRacer.s = w.raceDistance - 3;
    });
    await page.evaluate(() => window.motorush!.fastForward(3, { throttle: 1 }));

    await expect(page.locator('#screen-finish')).toBeVisible();
    // Marked by who is actually holding the screen, not by racer zero.
    await expect(page.locator('#finish-results li.is-player')).toHaveCount(1);
    await expect(page.locator('#finish-results li.is-player')).toContainText('HASAN');
  });
});

test.describe('the running order on the HUD', () => {
  test('shows the whole grid with gaps up and down the road', async ({ page }) => {
    await gotoGame(page);
    await startRace(page, { seed: 4244, riderName: 'HASAN' });
    await page.evaluate(() => {
      const w = window.motorush!.world()!;
      // One rider up the road, one behind, so both signs are on screen.
      w.rivals[0].s = w.localRacer.s + 13;
      w.rivals[1].s = w.localRacer.s - 30;
    });
    await page.evaluate(() => window.motorush!.fastForward(0.2, { throttle: 1 }));

    const board = page.locator('#hud-board .board__row');
    await expect(board).toHaveCount(8);
    await expect(page.locator('#hud-board .board__row.is-you')).toHaveCount(1);
    await expect(page.locator('#hud-board .board__row.is-you')).toContainText('HASAN');
    // Somebody ahead, somebody behind, and a place on every row.
    await expect(page.locator('#hud-board .board__gap:text-matches("\\\\+\\\\d")')).not.toHaveCount(0);
    await expect(page.locator('#hud-board .board__gap:text-matches("-\\\\d")')).not.toHaveCount(0);
    await expect(page.locator('#hud-board .board__pos').first()).toHaveText('#1');
  });
});

import type { Page } from '@playwright/test';
import type { DifficultyKey } from '../../src/sim/types';

// `src/main` declares `window.roadbrush`; importing its types (erased at
// runtime) means these tests fail to compile if that API ever changes.
import type {} from '../../src/main';

export async function gotoGame(page: Page): Promise<void> {
  await page.goto('/');
  // Wait for the renderer to finish loading textures and models.
  await page.waitForFunction(() => window.roadbrush?.ready() === true, null, { timeout: 45_000 });
  await page.waitForFunction(() => window.roadbrush?.mode() === 'menu');
}

/** Start a race with a fixed seed and skip the countdown. */
export async function startRace(
  page: Page,
  opts: { seed?: number; difficulty?: DifficultyKey; riderName?: string } = {},
): Promise<void> {
  await page.evaluate((o) => window.roadbrush!.start(o), opts);
  await page.waitForFunction(() => window.roadbrush?.mode() === 'racing', null, { timeout: 20_000 });
  // Run out the countdown so the race is actually live.
  await page.evaluate(() => window.roadbrush!.fastForward(4));
  await page.waitForFunction(() => window.roadbrush!.world()!.state === 'racing');
}

export async function worldState(page: Page) {
  return page.evaluate(() => {
    const w = window.roadbrush!.world()!;
    return {
      state: w.state,
      elapsed: w.elapsed,
      distance: w.player.s,
      speed: w.player.speed,
      health: w.player.health,
      place: w.player.place,
      racers: w.racers.length,
      raceDistance: w.raceDistance,
      heat: w.heat,
      hasCop: !!w.cop,
    };
  });
}

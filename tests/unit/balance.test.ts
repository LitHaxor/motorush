// Balance guard. Plays full races headlessly with the rival AI driving the
// player, then asserts the difficulty curve still holds. These are deliberately
// loose bounds: they catch a tuning change that breaks the game, not small
// drifts in feel.

import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/world';
import { aiInput, createAiState } from '../../src/sim/ai';
import type { DifficultyKey } from '../../src/sim/types';

const DT = 1 / 60;
const SEEDS = [1, 42, 777, 2024, 31337, 88, 1234, 5, 66, 909, 4242, 31];

interface Summary {
  finished: number;
  wins: number;
  podium: number;
  avgTime: number;
  avgCrashes: number;
  copsSeen: number;
}

/** Play every seed at one difficulty with a competent-but-imperfect bot. */
function sweep(difficulty: DifficultyKey): Summary {
  let finished = 0, wins = 0, podium = 0, time = 0, crashes = 0, cops = 0;
  for (const seed of SEEDS) {
    const w = new World({ seed, difficulty });
    w.player.ai = createAiState(w.rng);
    let guard = 0;
    while (w.state === 'countdown' && guard++ < 1000) {
      w.step(DT, { throttle: 1, brake: 0, steer: 0, attackLeft: false, attackRight: false });
    }
    while (w.state === 'racing' && guard++ < 60 * 600) {
      for (const e of w.step(DT, aiInput(w.player, w, DT))) {
        if (e.type === 'copSpawn') cops++;
      }
    }
    if (w.state === 'finished') finished++;
    if (w.player.place === 1) wins++;
    if (w.player.place <= 3) podium++;
    time += w.result?.time ?? 0;
    crashes += w.player.knockdowns;
  }
  const n = SEEDS.length;
  return { finished, wins, podium, avgTime: time / n, avgCrashes: crashes / n, copsSeen: cops };
}

describe('difficulty curve', () => {
  const easy = sweep('easy');
  const normal = sweep('normal');
  const hard = sweep('hard');

  it('is completable at every difficulty', () => {
    for (const [name, s] of [['easy', easy], ['normal', normal], ['hard', hard]] as const) {
      // Getting arrested or wasted is a legitimate outcome, so this only
      // guards against a difficulty becoming effectively unfinishable.
      expect(s.finished, `${name} should be finishable`).toBeGreaterThanOrEqual(SEEDS.length * 0.5);
    }
  });

  it('gets harder as you step up', () => {
    expect(easy.podium).toBeGreaterThanOrEqual(normal.podium);
    expect(normal.podium).toBeGreaterThanOrEqual(hard.podium);
    expect(hard.avgCrashes).toBeGreaterThan(easy.avgCrashes);
  });

  it('leaves winning on Normal genuinely contested', () => {
    // A merely competent rider should not run away with it, but it has to be
    // winnable or the rivals are simply faster than the player can ever be.
    expect(normal.wins).toBeLessThanOrEqual(SEEDS.length * 0.5);
    expect(normal.podium).toBeGreaterThan(0);
  });

  it('keeps races to a sensible length', () => {
    expect(easy.avgTime).toBeGreaterThan(25);
    expect(easy.avgTime).toBeLessThan(150);
    expect(hard.avgTime).toBeLessThan(260);
  });

  it('puts the police in play without them dominating', () => {
    // Roughly one patrol per race on Normal: enough to matter, not an escort.
    expect(normal.copsSeen).toBeGreaterThan(0);
    expect(normal.copsSeen).toBeLessThan(SEEDS.length * 4);
  });

  it('turns up the heat as you step up', () => {
    expect(hard.copsSeen).toBeGreaterThanOrEqual(normal.copsSeen);
  });
});

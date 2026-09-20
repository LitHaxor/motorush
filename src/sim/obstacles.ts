// Things beside the road that stop a motorcycle.
//
// Trees, and later posts and signs: anything solid that is not traffic and not
// the barrier. They live in the simulation rather than in the scenery builder
// for two reasons, and both matter.
//
// The first is that you have to be able to hit them. A trunk drawn by the
// renderer is scenery you ride through; a trunk the simulation knows about is
// an obstacle.
//
// The second is fairness. Every browser in a room builds its own world from
// the room's seed, so two riders only see the same trees if both arrive at
// them by the identical sequence of random draws. Scenery used to take its
// numbers from the world's shared generator, behind a `if (treeVariants.length)`
// guard - so a rider whose foliage atlas failed to load skipped those draws
// and got a different city. Obstacles draw from a stream of their own, keyed
// off the seed, which nothing else touches.

import { TRACK } from './config';
import { makeRng } from './mathx';
import type { BiomeSegment } from './biomes';
import type { Rng, Racer } from './types';
import type { Track } from './track';
import { damageRacer, isRiding, knockDown } from './racer';
import { CRASH, HEALTH } from './config';
import type { SimEvent } from './types';

/**
 * Keeps the obstacle stream clear of every other use of the seed.
 *
 * Any odd constant does; this one exists so that two subsystems seeded from
 * the same world never walk the same sequence.
 */
const OBSTACLE_SALT = 0x9e37;

/**
 * How much road is generated before the start line.
 *
 * Trees have to start before the grid or the first hundred metres look like a
 * building site. Matches the renderer's run-up closely enough that nothing
 * pops in; it does not have to match exactly, because nothing is collidable
 * behind the start line anyway.
 */
const RUNUP = 120;

/**
 * Clearance between the edge of the rideable corridor and the nearest trunk.
 *
 * Comfortably more than the lateral tolerance in `collideObstacles`, so a
 * rider held against the guardrail is never inside a tree.
 */
const STANDOFF = 1.2;

export interface Obstacle {
  id: number;
  /** Distance along the centreline. */
  s: number;
  /** Signed offset from the centreline; positive is the rider's right. */
  lateral: number;
  /** Trunk radius at the base, in metres - what you actually hit. */
  radius: number;
  /** How tall it stands. Visual, but the renderer sizes the crown from it. */
  height: number;
  /** Which island or verge it grew on, for the renderer's own choices. */
  onIsland: boolean;
}

/** How thickly each biome plants, and how far back from the road. */
const DENSITY: Record<string, { skip: number; reach: number; height: [number, number] }> = {
  country: { skip: 0.18, reach: 100, height: [8, 21] },
  hills: { skip: 0.1, reach: 130, height: [9, 24] },
  jungle: { skip: 0.02, reach: 70, height: [10, 26] },
  coast: { skip: 0.55, reach: 45, height: [9, 17] },
  paddy: { skip: 0.82, reach: 60, height: [5, 11] },
  city: { skip: 0.85, reach: 0, height: [5, 8] },
  mountain: { skip: 0.3, reach: 150, height: [7, 18] },
  village: { skip: 0.55, reach: 75, height: [6, 14] },
};

/**
 * A trunk's radius for a tree of this height.
 *
 * Deliberately generous against the drawn trunk, which tapers: you are hitting
 * a tree, and clipping the edge of one at 200 km/h should not be a near miss
 * that costs nothing.
 */
export const trunkRadius = (height: number): number => 0.12 + height * 0.022;

const biomeAt = (biomes: readonly BiomeSegment[], s: number): string =>
  biomes.find((b) => s >= b.from && s < b.to)?.kind ?? 'country';

/**
 * Plant the whole course.
 *
 * Deterministic in the seed alone: same seed, same trees, on every machine in
 * the room, whatever any of them managed to load.
 */
export function generateObstacles(
  track: Track,
  biomes: readonly BiomeSegment[],
  seed: number,
): Obstacle[] {
  const rng: Rng = makeRng((seed ^ OBSTACLE_SALT) >>> 0);
  const out: Obstacle[] = [];
  let id = 0;

  // --- the verges ---------------------------------------------------------
  for (let s = -RUNUP; s < track.length; s += rng.range(6, 13)) {
    const kind = biomeAt(biomes, s);
    const density = DENSITY[kind] ?? DENSITY.country;
    const urban = kind === 'city';

    for (const sign of [-1, 1] as const) {
      if (rng.chance(density.skip)) continue;

      const edge = track.edgeAt(s);
      const height = rng.range(density.height[0], density.height[1]);
      const radius = trunkRadius(height);
      /*
       * Clear of the corridor, and clear of its edge by more than a trunk.
       *
       * Two mistakes were made here in turn. Trees were first planted from two
       * metres past the tarmac, which is inside the shoulder, so they stood in
       * rideable ground. Moving them just past the guardrail was no better: a
       * rider grinding the rail is held at exactly `edge + shoulder`, and a
       * trunk eight hundred millimetres beyond that was still inside the reach
       * of the collision test - so scraping along the barrier threw you off
       * against a tree standing behind it, out of sight and out of reach.
       *
       * The standoff is the trunk's own radius plus the width of the test, so
       * a rider pinned against the rail cannot be touching one.
       */
      const nearest = edge + TRACK.shoulder + radius + STANDOFF;
      const distance = urban || density.reach <= 0
        ? rng.range(nearest, nearest + 3)
        : rng.range(nearest, Math.max(nearest + 4, density.reach));

      out.push({ id: id++, s, lateral: sign * distance, radius, height, onIsland: false });
    }
  }

  // --- the islands --------------------------------------------------------
  // A fork's island is planted, which is what makes it read as something you
  // cannot cut across. In town it is a block of buildings instead, and those
  // are solid by way of the track rather than by way of a trunk.
  for (const seg of track.divided) {
    if (!seg.fork) continue;
    for (let s = seg.from + 12; s < seg.to - 12; s += rng.range(7, 16)) {
      const median = track.medianAt(s);
      if (median < 4 || biomeAt(biomes, s) === 'city') continue;
      const room = median - 1.2;
      if (room <= 0.5) continue;
      const height = rng.range(4, 13);
      out.push({
        id: id++,
        s,
        lateral: rng.range(-room * 0.55, room * 0.55),
        radius: trunkRadius(height),
        height,
        onIsland: true,
      });
    }
  }

  /*
   * In order along the road, because the collision check bisects it.
   *
   * The verges are walked first and the islands afterwards, so what comes out
   * of the two passes is not sorted - and a bisection over an unsorted list
   * silently misses obstacles rather than failing, which is the worst way for
   * this to be wrong. Ties break on id so the order stays identical on every
   * machine, which is the whole point of generating them this way.
   */
  out.sort((a, b) => a.s - b.s || a.id - b.id);
  return out;
}

/** First index whose `s` is at or past `target`. The list is built in order. */
function lowerBound(obstacles: readonly Obstacle[], target: number): number {
  let lo = 0;
  let hi = obstacles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (obstacles[mid].s < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Ride into a tree and you stop being on the motorcycle.
 *
 * Checked against every rider, not just the player: a rival that could drive
 * through a trunk the player has to go round is a rival with a shortcut.
 */
export function collideObstacles(
  racers: readonly Racer[],
  obstacles: readonly Obstacle[],
  /** Only what is near the action, so this stays cheap at 60Hz. */
  aroundS: number,
  window = 220,
): SimEvent[] {
  const events: SimEvent[] = [];
  if (!obstacles.length) return events;

  /*
   * Only the stretch of road the riders are actually on.
   *
   * Walking every trunk on a seven-kilometre course for every rider, sixty
   * times a second, is two thousand-odd checks per rider per frame to discover
   * that almost all of them are a mile away. The list is built once in `s`
   * order, so the span in range can be found by bisection and the rest never
   * looked at - which is most of them.
   */
  const first = lowerBound(obstacles, aroundS - window);
  const last = lowerBound(obstacles, aroundS + window);

  for (const r of racers) {
    if (!isRiding(r)) continue;
    for (let i = first; i < last; i++) {
      const o = obstacles[i];
      // A bike is longer than it is wide, so the two axes are tested apart
      // rather than as a circle: clipping a trunk with your shoulder counts.
      if (Math.abs(o.s - r.s) > o.radius + 1.1) continue;
      if (Math.abs(o.lateral - r.lateral) > o.radius + 0.55) continue;

      const fatal = damageRacer(r, HEALTH.barrierDamage * 1.4);
      // Full severity: a tree does not deflect you the way a rail does, and
      // the rider goes over the bars rather than down with the bike.
      if (knockDown(r, 1)) {
        events.push({ type: 'crash', racer: r, cause: 'barrier', fatal });
      }
      // Shoved back the way they came, so they do not wake up inside it.
      r.lateral += Math.sign(r.lateral - o.lateral || 1) * (o.radius + 0.6);
      r.speed *= CRASH.slideRetain;
      break;
    }
  }
  return events;
}

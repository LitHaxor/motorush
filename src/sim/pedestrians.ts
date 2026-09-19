// City pedestrians. They gather at marked crossings and walk over the road;
// hit one and they cartwheel off into the verge.
//
// Only the ones near the player are simulated, so a city full of them costs
// almost nothing.

import { HOP, CITY, TRACK } from './config';
import { clamp } from './mathx';
import { isRiding } from './racer';
import type { Racer, Rng, SimEvent } from './types';

export const PED = {
  /** Crossings are spaced along each built-up stretch. */
  crossingSpacing: [95, 190] as [number, number],
  perCrossing: [1, 3] as [number, number],
  /**
   * Crossing pace.
   *
   * Scaled up with the crossing itself: moving people off the carriageway and
   * onto the kerb made the walk 28m instead of 23m, and at the old pace that
   * extra time in the road cost Outlaw six finishes in a forty-eight seed
   * sweep. They step out further, so they step out faster.
   */
  walkSpeed: [1.35, 2.3] as [number, number],
  /** Seconds waiting on the kerb before stepping out again. */
  waitTime: [1.5, 5] as [number, number],
  /**
   * What clipping somebody costs you.
   *
   * A share rather than a flat figure: a fixed 25km/h was tried and it is
   * brutal at low speed and barely felt at high, and a 48-seed sweep put
   * Outlaw under the completable floor with it.
   */
  speedPenalty: 0.93,
  /** Only simulate within this distance of the player. */
  activeRange: 260,
  /** People lining the verge at the start line. */
  startCrowd: 22,
  /** Pedestrians per 100 m of city pavement, each side. */
  walkersPer100m: 2.2,
  strollSpeed: [0.9, 1.6] as [number, number],
  /** Hit box, metres. */
  hitLength: 1.1,
  hitWidth: 0.9,
  /** Speed the rider loses for clattering into someone. */
  /** Seconds spent airborne + flat out before they pick themselves up. */
  downTime: 6,
  gravity: -17,
};

/** Crossers walk over the road; spectators line the verge and cheer. */
export type PedestrianKind = 'crosser' | 'spectator' | 'marshal' | 'walker';

export interface Pedestrian {
  id: number;
  kind: PedestrianKind;
  /** Where along the track their crossing is. */
  s: number;
  lateral: number;
  /** Height above the road - only non-zero once they have been launched. */
  height: number;
  dir: 1 | -1;
  speed: number;
  state: 'walking' | 'waiting' | 'cheering' | 'strolling' | 'flying' | 'down';
  timer: number;
  /** Launch velocity, set when they get hit. */
  velLateral: number;
  velUp: number;
  velAlong: number;
  spin: number;
  spinRate: number;
  colour: number;
  /** The kerb-to-kerb extent of their crossing. */
  span: number;
  /** Walkers only: which way along the pavement they are headed. */
  along: 1 | -1;
  /** Walkers only: the stretch of pavement they patrol. */
  minS: number;
  maxS: number;
}

export interface Crossing {
  s: number;
  /** Signal state drives the light colour and whether they step out. */
  walkPhase: number;
}

export const PED_COLOURS = [
  0x3f6fb5, 0xb5553f, 0x4a9e6b, 0x8a5fb0, 0xb59b3f, 0x555f6b, 0xb04f7a,
] as const;

export interface CitySpan {
  from: number;
  to: number;
}

/**
 * Lay out crossings and the people using them. `citySpans` comes from the same
 * seeded generator the renderer uses, so signs and stripes line up.
 */
export function generatePedestrians(
  citySpans: readonly CitySpan[],
  rng: Rng,
): { crossings: Crossing[]; pedestrians: Pedestrian[] } {
  const crossings: Crossing[] = [];
  const pedestrians: Pedestrian[] = [];
  let id = 0;
  // Crossers wait on the kerb and step off it, so they start where the
  // pavement is - not at 11.5m, which is inside the barrier and reads as
  // somebody standing about in the middle of the road.
  const span = TRACK.halfWidth + CITY.walkway[0];

  for (const seg of citySpans) {
    let s = seg.from + rng.range(40, 90);
    while (s < seg.to - 30) {
      crossings.push({ s, walkPhase: rng() * Math.PI * 2 });
      const count = rng.int(PED.perCrossing[0], PED.perCrossing[1]);
      for (let i = 0; i < count; i++) {
        const dir: 1 | -1 = rng.chance(0.5) ? 1 : -1;
        pedestrians.push({
          id: id++,
          kind: 'crosser',
          s: s + rng.range(-1.6, 1.6),
          lateral: -dir * span,
          height: 0,
          dir,
          speed: rng.range(PED.walkSpeed[0], PED.walkSpeed[1]),
          state: rng.chance(0.5) ? 'walking' : 'waiting',
          timer: rng.range(PED.waitTime[0], PED.waitTime[1]),
          velLateral: 0,
          velUp: 0,
          velAlong: 0,
          spin: 0,
          spinRate: 0,
          colour: rng.pick(PED_COLOURS),
          span,
          along: 1,
          minS: 0,
          maxS: 0,
        });
      }
      s += rng.range(PED.crossingSpacing[0], PED.crossingSpacing[1]);
    }
  }

  // --- start line crowd ---------------------------------------------------
  // A marshal with the flag plus spectators lining the verge. They stay off
  // the road, but run wide and you will scatter them.
  const verge = TRACK.halfWidth + 1.2;
  for (let i = 0; i < PED.startCrowd; i++) {
    const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;
    pedestrians.push({
      id: id++,
      kind: i === 0 ? 'marshal' : 'spectator',
      s: i === 0 ? 6 : rng.range(-10, 46),
      lateral: side * (verge + rng.range(0, 3.4)),
      height: 0,
      dir: side,
      speed: 0,
      state: 'cheering',
      // Staggered so the crowd does not bob in unison.
      timer: rng() * Math.PI * 2,
      velLateral: 0,
      velUp: 0,
      velAlong: 0,
      spin: 0,
      spinRate: 0,
      colour: rng.pick(PED_COLOURS),
      span: verge + 4,
      along: 1,
      minS: 0,
      maxS: 0,
    });
  }

  // --- city pavements ------------------------------------------------------
  // People going about their business on both pavements. They stay on the
  // kerb, so you only hit one if you leave the road.
  // On the pavement: past the barrier at 4.5 so nobody is standing in the
  // road, and short of the building line at 8 so nobody is standing in a wall.
  const pavement = TRACK.halfWidth + CITY.walkway[0];
  const pavementSpread = CITY.walkway[1] - CITY.walkway[0];
  for (const seg of citySpans) {
    const count = Math.round(((seg.to - seg.from) / 100) * PED.walkersPer100m);
    for (let i = 0; i < count; i++) {
      for (const side of [-1, 1] as const) {
        const along: 1 | -1 = rng.chance(0.5) ? 1 : -1;
        pedestrians.push({
          id: id++,
          kind: 'walker',
          s: rng.range(seg.from, seg.to),
          lateral: side * (pavement + rng.range(0, pavementSpread)),
          height: 0,
          dir: side,
          speed: rng.range(PED.strollSpeed[0], PED.strollSpeed[1]),
          state: 'strolling',
          timer: rng() * Math.PI * 2,
          velLateral: 0,
          velUp: 0,
          velAlong: 0,
          spin: 0,
          spinRate: 0,
          colour: rng.pick(PED_COLOURS),
          span: pavement + pavementSpread,
          along,
          minS: seg.from - 10,
          maxS: seg.to + 10,
        });
      }
    }
  }

  return { crossings, pedestrians };
}

/** Launch a pedestrian. `impact` is the rider's speed in m/s. */
export function launch(p: Pedestrian, impact: number, fromLateral: number): void {
  const away = p.lateral >= fromLateral ? 1 : -1;
  const power = clamp(impact / 40, 0.5, 2.4);
  p.state = 'flying';
  p.timer = PED.downTime;
  p.velAlong = impact * 0.35 + 4;
  p.velUp = 5.5 * power;
  p.velLateral = away * 3.5 * power;
  p.spinRate = (6 + power * 7) * away;
}

export function stepPedestrians(
  pedestrians: readonly Pedestrian[],
  racers: readonly Racer[],
  playerS: number,
  dt: number,
): SimEvent[] {
  const events: SimEvent[] = [];

  for (const p of pedestrians) {
    // Skip anyone far up or down the road.
    if (Math.abs(p.s - playerS) > PED.activeRange) continue;

    switch (p.state) {
      case 'waiting':
        p.timer -= dt;
        if (p.timer <= 0 && p.kind === 'crosser') p.state = 'walking';
        else if (p.timer <= 0 && p.kind === 'walker') p.state = 'strolling';
        break;

      case 'cheering':
        // Purely decorative; the render layer bobs them using this.
        p.timer += dt;
        break;

      case 'strolling': {
        // Up and down the pavement, turning round at the end of the block.
        p.s += p.along * p.speed * dt;
        if (p.s < p.minS) {
          p.s = p.minS;
          p.along = 1;
        } else if (p.s > p.maxS) {
          p.s = p.maxS;
          p.along = -1;
        }
        break;
      }

      case 'walking': {
        p.lateral += p.dir * p.speed * dt;
        if (Math.abs(p.lateral) >= p.span) {
          // Reached the far kerb; wait, then head back.
          p.lateral = Math.sign(p.lateral) * p.span;
          p.dir = (p.dir === 1 ? -1 : 1) as 1 | -1;
          p.state = 'waiting';
          p.timer = PED.waitTime[0] + Math.abs(Math.sin(p.s)) * (PED.waitTime[1] - PED.waitTime[0]);
        }
        break;
      }

      case 'flying': {
        p.velUp += PED.gravity * dt;
        p.height += p.velUp * dt;
        p.lateral += p.velLateral * dt;
        p.s += p.velAlong * dt;
        p.spin += p.spinRate * dt;
        p.velAlong *= 1 - 1.4 * dt;
        p.velLateral *= 1 - 1.0 * dt;
        p.timer -= dt;
        if (p.height <= 0) {
          // Landed. Bounce once, then stay down.
          p.height = 0;
          if (p.velUp < -4) {
            p.velUp *= -0.32;
            p.spinRate *= 0.5;
          } else {
            p.state = 'down';
            p.velUp = 0;
            p.spinRate = 0;
          }
        }
        break;
      }

      case 'down':
        p.timer -= dt;
        if (p.timer <= 0) {
          // Dust themselves off and go back to where they were.
          p.state = p.kind === 'crosser'
            ? 'waiting'
            : p.kind === 'walker' ? 'strolling' : 'cheering';
          p.timer = 2;
          p.lateral = clamp(p.lateral, -p.span, p.span);
          p.height = 0;
          p.spin = 0;
        }
        break;
    }

    if (p.state === 'flying' || p.state === 'down') continue;

    // --- getting clattered ------------------------------------------------
    for (const r of racers) {
      if (!isRiding(r)) continue;
      if (Math.abs(r.s - p.s) > PED.hitLength) continue;
      if (Math.abs(r.lateral - p.lateral) > PED.hitWidth) continue;

      launch(p, r.speed, r.lateral);
      // Ride over somebody and the bike goes light: a kick up, scaled by how
      // fast you were going, that gravity takes back over the next moment.
      const force = Math.min(1, r.speed / HOP.launchAt);
      r.hopVel = Math.max(r.hopVel, HOP.launch * force);
      r.speed *= PED.speedPenalty;
      events.push({ type: 'pedestrianHit', racer: r, pedestrian: p, impact: r.speed });
      break;
    }
  }

  return events;
}

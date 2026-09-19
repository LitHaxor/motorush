// Civilian traffic. A fixed pool of cars is recycled through a window around
// the player, so memory and draw calls stay constant no matter how long the
// race runs.

import { TRACK, TRAFFIC, CRASH, HEALTH, BIKE_HALF } from './config';
import { clamp } from './mathx';
import { isRiding, knockDown, damageRacer } from './racer';
import type { Track } from './track';
import type { Car, CarType, Racer, Rng, SimEvent } from './types';

const BUMP_COOLDOWN = 0.45;

export const CAR_TYPES: readonly CarType[] = [
  { key: 'sedan', length: 4.5, width: 1.9, height: 1.45, weight: 4 },
  { key: 'hatch', length: 4.0, width: 1.85, height: 1.5, weight: 3 },
  { key: 'van', length: 5.4, width: 2.05, height: 2.25, weight: 2 },
  { key: 'truck', length: 8.6, width: 2.35, height: 3.1, weight: 1.4 },
  { key: 'bus', length: 10.5, width: 2.4, height: 3.3, weight: 0.8 },
];

export const CAR_COLORS = [
  0xd8d8dc, 0x2b2f3a, 0x8c1f24, 0x1f4d8c, 0x2c6e49, 0xe0a422, 0x6b4f9a, 0xb35c2a,
] as const;

function pickCarType(rng: Rng): CarType {
  const total = CAR_TYPES.reduce((a, t) => a + t.weight, 0);
  let roll = rng() * total;
  for (const t of CAR_TYPES) {
    roll -= t.weight;
    if (roll <= 0) return t;
  }
  return CAR_TYPES[0];
}

export class TrafficSystem {
  readonly track: Track;
  readonly rng: Rng;
  readonly density: number;
  readonly cars: Car[] = [];

  constructor(track: Track, rng: Rng, { density = 1 }: { density?: number } = {}) {
    this.track = track;
    this.rng = rng;
    this.density = density;
    const count = Math.max(4, Math.round(TRAFFIC.count * density));
    for (let i = 0; i < count; i++) {
      this.cars.push({
        id: i,
        s: 0,
        lateral: 0,
        speed: 0,
        dir: 1,
        type: CAR_TYPES[0],
        color: CAR_COLORS[0],
        laneIndex: 2,
        active: false,
        swerve: 0,
        swervePhase: 0,
      });
    }
  }

  /** Seed the road with cars before the lights go out. */
  prime(playerS: number): void {
    for (const car of this.cars) this.respawn(car, playerS, true);
  }

  laneFor(dir: 1 | -1): number {
    // Lanes 0/1 carry oncoming traffic, 2/3 run with the player.
    const pool = dir === 1 ? [2, 3] : [0, 1];
    return pool[this.rng.int(0, 1)];
  }

  respawn(car: Car, playerS: number, initial = false): Car {
    const rng = this.rng;
    // Slightly more oncoming traffic than same-direction: it is the real hazard.
    const dir: 1 | -1 = rng.chance(0.55) ? -1 : 1;
    const laneIndex = this.laneFor(dir);
    const type = pickCarType(rng);

    let s: number;
    if (initial) {
      s = playerS + rng.range(60, TRAFFIC.spawnAhead);
    } else if (dir === 1 && rng.chance(0.25)) {
      s = playerS - rng.range(60, TRAFFIC.spawnBehind); // overtaken from behind
    } else {
      s = playerS + rng.range(TRAFFIC.spawnAhead * 0.55, TRAFFIC.spawnAhead);
    }

    // Keep a gap so cars never spawn stacked inside each other.
    for (const other of this.cars) {
      if (other === car || !other.active) continue;
      if (other.laneIndex === laneIndex && Math.abs(other.s - s) < TRAFFIC.minGap) {
        s += TRAFFIC.minGap * (s > other.s ? 1 : -1);
      }
    }

    const range = dir === 1 ? TRAFFIC.sameDirSpeed : TRAFFIC.oncomingSpeed;
    const heavy = type.key === 'truck' || type.key === 'bus';
    car.s = s;
    car.dir = dir;
    car.laneIndex = laneIndex;
    car.lateral = TRACK.laneCentres[laneIndex] + rng.range(-0.55, 0.55);
    car.speed = rng.range(range[0], range[1]) * (heavy ? 0.78 : 1);
    car.type = type;
    car.color = rng.pick(CAR_COLORS);
    car.active = true;
    car.swervePhase = rng() * Math.PI * 2;
    car.swerve = rng.range(0.1, 0.4);
    return car;
  }

  step(dt: number, playerS: number, elapsed: number): void {
    const ahead = TRAFFIC.spawnAhead + 90;
    const behind = TRAFFIC.spawnBehind + 90;
    for (const car of this.cars) {
      if (!car.active) {
        this.respawn(car, playerS);
        continue;
      }
      car.s += car.speed * car.dir * dt;
      // Lazy lane drift so traffic does not look like it is on rails.
      const lane = TRACK.laneCentres[car.laneIndex];
      car.lateral = lane + Math.sin(elapsed * 0.6 + car.swervePhase) * car.swerve;

      if (car.s > playerS + ahead || car.s < playerS - behind) {
        this.respawn(car, playerS);
      }
    }
  }

  /** Signed longitudinal velocity in track space. */
  static velocity(car: Car): number {
    return car.speed * car.dir;
  }
}

/**
 * Racer vs. traffic. Hard impacts put you down; glancing blows just scrub speed
 * and chip health.
 */
export function collideWithTraffic(racers: readonly Racer[], traffic: TrafficSystem): SimEvent[] {
  const events: SimEvent[] = [];
  for (const r of racers) {
    if (!isRiding(r)) continue;
    for (const car of traffic.cars) {
      if (!car.active) continue;
      const ds = car.s - r.s;
      const halfLen = car.type.length / 2 + BIKE_HALF.length;
      if (Math.abs(ds) > halfLen) continue;
      const dx = car.lateral - r.lateral;
      const halfWid = car.type.width / 2 + BIKE_HALF.width;
      if (Math.abs(dx) > halfWid) continue;

      const closing = Math.abs(r.speed - TrafficSystem.velocity(car));
      if (closing > CRASH.hardImpactSpeed) {
        const fatal = damageRacer(r, HEALTH.crashDamage);
        if (knockDown(r, clamp(closing / 60, 0.4, 1))) {
          events.push({ type: 'crash', racer: r, cause: 'traffic', car, closing, fatal });
        }
      } else {
        // Scrape: shove clear, lose a little speed and health.
        const push = dx > 0 ? -1 : 1;
        r.lateral += push * 0.55;
        r.staggerPush = push * 2.4;
        r.speed *= 0.9;
        const fatal = damageRacer(r, HEALTH.scrapeDamage * 0.35);
        events.push({ type: 'scrape', racer: r, car, fatal });
        if (fatal) knockDown(r, 0.6);
      }
      break; // one collision per racer per tick is plenty
    }
  }
  return events;
}

/** Racer vs. racer body contact - bumping, not punching. */
export function collideRacers(racers: readonly Racer[]): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < racers.length; i++) {
    const a = racers[i];
    if (!isRiding(a)) continue;
    for (let j = i + 1; j < racers.length; j++) {
      const b = racers[j];
      if (!isRiding(b)) continue;
      const ds = b.s - a.s;
      if (Math.abs(ds) > BIKE_HALF.length * 2) continue;
      const dx = b.lateral - a.lateral;
      const minGap = BIKE_HALF.width * 2 + 0.35;
      if (Math.abs(dx) > minGap) continue;

      const push = (minGap - Math.abs(dx)) * 0.5 * (dx >= 0 ? 1 : -1);
      a.lateral -= push;
      b.lateral += push;
      a.speed *= 0.985;
      b.speed *= 0.985;
      // Only report the moment of contact, not every tick spent rubbing.
      if (a.bumpCooldown <= 0 && b.bumpCooldown <= 0) {
        events.push({ type: 'bump', a, b });
      }
      a.bumpCooldown = BUMP_COOLDOWN;
      b.bumpCooldown = BUMP_COOLDOWN;
    }
  }
  return events;
}

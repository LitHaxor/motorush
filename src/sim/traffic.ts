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
  // No bus in the model kit, so this is a long coach-style van rather
  // than a full bus - stretching a 3 m model to 10.5 m looks absurd.
  { key: 'bus', length: 7.8, width: 2.35, height: 3.1, weight: 0.8 },
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
        cruise: 0,
        brake: 0,
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

  /**
   * Everybody the road has to look busy for.
   *
   * Riders bunch for most of a race, so this is usually one cluster and costs
   * nothing. It matters at the ends: a rider a kilometre clear of the field
   * should still be passing cars.
   */
  private interestPoints(
    racers: readonly Racer[],
    playerS: number,
    playerSpeed: number,
  ): Array<{ s: number; speed: number }> {
    const points = [{ s: playerS, speed: playerSpeed }];
    for (const r of racers) {
      if (r.kind === 'cop') continue;
      if (points.some((p) => Math.abs(p.s - r.s) < TRAFFIC.spawnAhead * 0.5)) continue;
      points.push({ s: r.s, speed: r.speed });
    }
    return points;
  }

  /** Whichever rider currently has the least traffic around them. */
  private neediest(
    points: Array<{ s: number; speed: number }>,
  ): { s: number; speed: number } {
    let worst = points[0];
    let fewest = Infinity;
    for (const p of points) {
      let near = 0;
      for (const car of this.cars) {
        if (car.active && Math.abs(car.s - p.s) < TRAFFIC.spawnAhead) near++;
      }
      if (near < fewest) {
        fewest = near;
        worst = p;
      }
    }
    return worst;
  }

  /**
   * The stretches of road nobody may have a car appear in, merged.
   *
   * One span per rider - a long one in front of them, a short one behind -
   * combined so overlapping riders do not have to be considered separately.
   */
  private blockedSpans(riders: readonly Racer[]): Array<[number, number]> {
    const spans = riders
      .map((r): [number, number] =>
        [r.s - TRAFFIC.spawnClearBehind, r.s + TRAFFIC.spawnClearAhead])
      .sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push([span[0], span[1]]);
    }
    return merged;
  }

  /**
   * Somewhere in `[from, to]` that is not inside any of `blocked`.
   *
   * Worked out rather than guessed at. Sampling the window and hoping was
   * fine for one rider, but eight of them strung along the road block more of
   * it than they leave, and the gaps that remain are too narrow to stumble
   * into - so the free stretches are subtracted out and one is chosen. Null
   * when the whole window is spoken for, which the caller widens and retries.
   */
  private freeSlot(
    from: number,
    to: number,
    blocked: readonly (readonly [number, number])[],
    rng: Rng,
  ): number | null {
    const gaps: Array<[number, number]> = [];
    let cursor = from;
    for (const [lo, hi] of blocked) {
      if (hi <= cursor) continue;
      if (lo >= to) break;
      if (lo > cursor) gaps.push([cursor, Math.min(lo, to)]);
      cursor = Math.max(cursor, hi);
      if (cursor >= to) break;
    }
    if (cursor < to) gaps.push([cursor, to]);

    // A gap too small to hold a car with room either side is not a gap.
    const usable = gaps.filter(([lo, hi]) => hi - lo > 12);
    if (!usable.length) return null;
    // The widest, so the car has the most room around it.
    const best = usable.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
    return rng.range(best[0] + 4, best[1] - 4);
  }

  respawn(
    car: Car,
    playerS: number,
    initial = false,
    playerSpeed = Infinity,
    /** Everybody on the road, so nothing is dropped in front of any of them. */
    riders: readonly Racer[] = [],
  ): Car {
    const rng = this.rng;
    // Slightly more oncoming traffic than same-direction: it is the real hazard.
    const dir: 1 | -1 = rng.chance(0.55) ? -1 : 1;
    const laneIndex = this.laneFor(dir);
    const type = pickCarType(rng);

    // Speed first, because whether this car may be put behind the rider
    // depends on whether the rider is actually going to pull away from it.
    const range = dir === 1 ? TRAFFIC.sameDirSpeed : TRAFFIC.oncomingSpeed;
    const heavy = type.key === 'truck' || type.key === 'bus';
    const speed = rng.range(range[0], range[1]) * (heavy ? 0.78 : 1);

    /*
     * A car put behind you is one you are about to overtake - never one that
     * is about to overtake you.
     *
     * It used to be placed there on a quarter of recycles regardless, sixty
     * metres back. Ride slowly - just remounted after a crash, or picking your
     * way through traffic - and a car appeared behind at nearly thirty metres a
     * second and drove into the back of you, with nothing on screen to have
     * warned you it was coming.
     */
    const overtaking = playerSpeed > speed + TRAFFIC.overtakeMargin;

    // Where this car would like to go, as a function we can ask more than once.
    const propose = (): number => {
      if (initial) return playerS + rng.range(60, TRAFFIC.spawnAhead);
      if (dir === 1 && overtaking && rng.chance(0.25)) {
        return playerS - rng.range(60, TRAFFIC.spawnBehind); // overtaken from behind
      }
      return playerS + rng.range(TRAFFIC.spawnAhead * TRAFFIC.spawnAheadNear, TRAFFIC.spawnAhead);
    };

    /*
     * Keep asking until the spot is out of sight of everyone, then settle.
     *
     * With a field strung out along the road there is not always a clear slot,
     * so this does not loop for ever hoping: it takes a bounded number of
     * tries and, failing all of them, keeps whichever was furthest from the
     * nearest rider. A car appearing half a kilometre from somebody is a
     * compromise; one appearing in front of them is a collision they could not
     * have avoided.
     */
    let s = propose();
    if (riders.length) {
      /*
       * Riders and cars in one set of blocked ground.
       *
       * These used to be applied one after the other: the slot was chosen
       * clear of every rider, and then a separate pass shoved the car up to
       * seventy metres to keep it off another car in its lane - straight back
       * into the view it had just been kept out of. Two constraints applied in
       * sequence are not the same as two constraints.
       */
      const blocked = this.blockedSpans(riders);
      for (const other of this.cars) {
        if (other === car || !other.active || other.laneIndex !== laneIndex) continue;
        blocked.push([other.s - TRAFFIC.minGap, other.s + TRAFFIC.minGap]);
      }
      blocked.sort((a, b) => a[0] - b[0]);
      const inBlocked = blocked.some(([lo, hi]) => s > lo && s < hi);
      if (inBlocked) {
        const A = TRAFFIC.spawnAhead;
        // The window this car wanted, then progressively further up the road.
        // Nothing is ever placed closer in to make room - that is the one
        // direction that would put it in somebody's view.
        const windows: Array<[number, number]> = [
          [playerS + A * TRAFFIC.spawnAheadNear, playerS + A],
          [playerS + A, playerS + A * 1.6],
          [playerS + A * 1.6, playerS + A * 2.4],
        ];
        let found: number | null = null;
        for (const [from, to] of windows) {
          found = this.freeSlot(from, to, blocked, rng);
          if (found !== null) break;
        }
        // Every window spoken for - which takes a field covering kilometres.
        // Park it beyond the furthest rider rather than among them.
        s = found ?? Math.max(...riders.map((r) => r.s)) + TRAFFIC.spawnClearAhead + 20;
      }
    }

    // Keep a gap so cars never spawn stacked inside each other. Only needed
    // when there is no field to place around - with riders, the search above
    // has already taken the other cars into account, and nudging here would
    // undo it.
    if (!riders.length) {
      for (const other of this.cars) {
        if (other === car || !other.active) continue;
        if (other.laneIndex === laneIndex && Math.abs(other.s - s) < TRAFFIC.minGap) {
          s += TRAFFIC.minGap * (s > other.s ? 1 : -1);
        }
      }
    }

    car.s = s;
    car.dir = dir;
    car.laneIndex = laneIndex;
    car.lateral = this.track.laneAt(TRACK.laneCentres[laneIndex], s) + rng.range(-0.55, 0.55);
    car.speed = speed;
    car.cruise = car.speed;
    car.brake = 0;
    car.type = type;
    car.color = rng.pick(CAR_COLORS);
    car.active = true;
    car.swervePhase = rng() * Math.PI * 2;
    car.swerve = rng.range(0.1, 0.4);
    return car;
  }

  step(
    dt: number,
    playerS: number,
    elapsed: number,
    racers: readonly Racer[] = [],
    /** How fast the rider is going, so nothing is recycled in behind them. */
    playerSpeed = Infinity,
  ): void {
    const ahead = TRAFFIC.spawnAhead + 90;
    const behind = TRAFFIC.spawnBehind + 90;
    // Where traffic is wanted. The pool used to be recycled entirely around one
    // rider, so in a race anybody more than a few hundred metres from them rode
    // an empty road - which is both a different game and, online, an advantage.
    const interest = this.interestPoints(racers, playerS, playerSpeed);
    this.lastRiders = racers;

    for (const car of this.cars) {
      if (!car.active) {
        const want = this.neediest(interest);
        this.respawn(car, want.s, false, want.speed);
        continue;
      }

      // Drivers are not suicidal: a car coming up behind a bike in its lane
      // lifts off rather than driving straight through the back of it.
      car.brake = 0;
      if (car.dir === 1) {
        for (const r of racers) {
          if (!isRiding(r) && r.state !== 'down') continue;
          if (Math.abs(r.lateral - car.lateral) > TRAFFIC.avoidWidth) continue;
          const gap = r.s - car.s;
          if (gap < 0 || gap > TRAFFIC.lookAhead) continue;
          car.brake = Math.max(car.brake, brakeDemand(gap, car.speed - r.speed));
        }
      }

      // And they are not suicidal about each other either. Without this a
      // faster car simply drives through the slow one in front: nothing in
      // the sim ever compared one car against another.
      for (const other of this.cars) {
        if (other === car || !other.active || other.dir !== car.dir) continue;
        if (Math.abs(other.lateral - car.lateral) > sideClearance(car, other)) continue;
        // Bumper to bumper, along the direction this car is travelling.
        const gap = (other.s - car.s) * car.dir - (car.type.length + other.type.length) / 2;
        if (gap > TRAFFIC.lookAhead) continue;
        if (gap <= 0) { car.brake = 1; continue; }
        car.brake = Math.max(car.brake, brakeDemand(gap, car.speed - other.speed));
      }
      if (car.brake > 0) {
        const target = car.cruise * (1 - car.brake);
        car.speed = Math.max(0, car.speed - TRAFFIC.brakeDecel * car.brake * dt);
        if (car.speed < target) car.speed = target;
      } else if (car.speed < car.cruise) {
        car.speed = Math.min(car.cruise, car.speed + TRAFFIC.accel * dt);
      }

      car.s += car.speed * car.dir * dt;
      // Lazy lane drift so traffic does not look like it is on rails. The
      // lane itself moves outward where a median splits the carriageways.
      const lane = this.track.laneAt(TRACK.laneCentres[car.laneIndex], car.s);
      car.lateral = lane + Math.sin(elapsed * 0.6 + car.swervePhase) * car.swerve;

      // Out of everybody's window, not just out of one rider's.
      const stranded = interest.every(
        (i) => car.s > i.s + ahead || car.s < i.s - behind,
      );
      if (stranded) {
        const want = this.neediest(interest);
        this.respawn(car, want.s, false, want.speed, racers);
      }
    }

    this.rebalance(interest);
    this.separate();
  }

  /**
   * Move traffic towards whoever has none.
   *
   * Recycling alone cannot do this. A car only recycles when it falls out of
   * somebody's window, so a pool sitting comfortably around the pack never
   * becomes free to serve a rider who has broken away - they simply ride an
   * empty road for the rest of the race. One car a frame is moved across,
   * which converges in a fraction of a second and costs nothing.
   */
  /** The field as of the last step, for the rebalancer's own respawns. */
  private lastRiders: readonly Racer[] = [];

  private rebalance(points: Array<{ s: number; speed: number }>): void {
    if (points.length < 2) return;
    const counts = points.map((p) =>
      this.cars.filter((c) => c.active && Math.abs(c.s - p.s) < TRAFFIC.spawnAhead).length);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    // A difference of one is just where the cars happen to be this instant.
    if (max - min < 2) return;

    const needy = points[counts.indexOf(min)];
    const rich = points[counts.indexOf(max)];
    // Take the least useful car the well-served rider has: the one furthest
    // behind them, which they have already gone past.
    let pick: Car | null = null;
    let furthestBehind = -Infinity;
    for (const car of this.cars) {
      if (!car.active || Math.abs(car.s - rich.s) >= TRAFFIC.spawnAhead) continue;
      const behind = rich.s - car.s;
      if (behind > furthestBehind) {
        furthestBehind = behind;
        pick = car;
      }
    }
    if (pick) this.respawn(pick, needy.s, false, needy.speed, this.lastRiders);
  }

  /**
   * Braking is a model and models run out of road: a car that spawns close
   * behind a slow one, or a lane that narrows around a median, can still put
   * two cars inside each other. This is the backstop - whatever happened
   * during the frame, no two cars end it overlapping.
   */
  private separate(): void {
    for (const car of this.cars) {
      if (!car.active) continue;
      for (const other of this.cars) {
        if (other === car || !other.active || other.dir !== car.dir) continue;
        const ahead = (other.s - car.s) * car.dir;
        // Resolve each pair once, from the trailing car's point of view.
        if (ahead <= 0) continue;
        if (Math.abs(other.lateral - car.lateral) > sideClearance(car, other)) continue;
        const minGap = (car.type.length + other.type.length) / 2 + 0.6;
        if (ahead >= minGap) continue;
        car.s = other.s - car.dir * minGap;
        if (car.speed > other.speed) car.speed = other.speed;
      }
    }
  }

  /** Signed longitudinal velocity in track space. */
  static velocity(car: Car): number {
    return car.speed * car.dir;
  }
}

/**
 * How hard this driver has to brake, as a fraction of full braking, to shed
 * `closing` over `gap` metres. A linear ramp is not enough - it lets a car
 * sail straight into the back of whatever it is catching.
 */
function brakeDemand(gap: number, closing: number): number {
  if (closing <= 0) return 0;
  const room = Math.max(gap - TRAFFIC.followGap, 0.25);
  return clamp((closing * closing) / (2 * room) / TRAFFIC.brakeDecel, 0, 1);
}

/** Lateral distance at which two cars count as sharing a lane. */
function sideClearance(a: Car, b: Car): number {
  return (a.type.width + b.type.width) / 2 + 0.3;
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

      // Which axis did contact happen on? Whichever is least overlapped is the
      // face you actually struck. Running into the back of a car (or an
      // oncoming bonnet) puts you down; drifting into its flank does not, it
      // just scrapes you along and shoves you clear.
      const penetrationS = halfLen - Math.abs(ds);
      const penetrationX = halfWid - Math.abs(dx);
      const headOn = penetrationS <= penetrationX;

      const closing = Math.abs(r.speed - TrafficSystem.velocity(car));
      if (headOn && closing > CRASH.hardImpactSpeed) {
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

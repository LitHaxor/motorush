import { describe, it, expect } from 'vitest';
import { Track } from '../../src/sim/track';
import { makeRng } from '../../src/sim/mathx';
import { createRacer } from '../../src/sim/racer';
import { TrafficSystem, collideWithTraffic, collideRacers, CAR_TYPES } from '../../src/sim/traffic';
import { TRAFFIC, CRASH, HEALTH } from '../../src/sim/config';
import type { Car } from '../../src/sim/types';

const track = new Track({ seed: 6, length: 4000 });
const build = (density = 1) => new TrafficSystem(track, makeRng(77), { density });

/** Park a single car right on top of the rider for collision tests. */
function only(traffic: TrafficSystem, patch: Partial<Car>): Car {
  for (const c of traffic.cars) c.active = false;
  const car = traffic.cars[0];
  Object.assign(car, { active: true, s: 100, lateral: 0, speed: 20, dir: 1, type: CAR_TYPES[0] }, patch);
  return car;
}

describe('TrafficSystem', () => {
  it('scales the pool with density but keeps a floor', () => {
    expect(build(1).cars.length).toBe(TRAFFIC.count);
    expect(build(1.3).cars.length).toBeGreaterThan(TRAFFIC.count);
    expect(build(0.01).cars.length).toBeGreaterThanOrEqual(4);
  });

  it('primes every car ahead of the player', () => {
    const t = build();
    t.prime(0);
    expect(t.cars.every((c) => c.active)).toBe(true);
    expect(t.cars.every((c) => c.s > 0)).toBe(true);
  });

  it('puts oncoming traffic on the left and same-direction on the right', () => {
    const t = build();
    t.prime(0);
    for (const car of t.cars) {
      if (car.dir === -1) expect(car.laneIndex).toBeLessThan(2);
      else expect(car.laneIndex).toBeGreaterThanOrEqual(2);
    }
  });

  it('recycles cars that fall outside the window instead of allocating', () => {
    const t = build();
    t.prime(0);
    const before = t.cars.length;
    const ids = t.cars.map((c) => c.id).sort();
    for (let i = 0; i < 600; i++) t.step(1 / 60, i * 2, i / 60);
    expect(t.cars.length).toBe(before);
    expect(t.cars.map((c) => c.id).sort()).toEqual(ids);
    // Everything stays within a sane band around the player.
    const playerS = 599 * 2;
    for (const car of t.cars) {
      expect(car.s).toBeGreaterThan(playerS - TRAFFIC.spawnBehind - 200);
      expect(car.s).toBeLessThan(playerS + TRAFFIC.spawnAhead + 200);
    }
  });

  it('brakes rather than driving through the back of a rider', () => {
    const sys = build();
    const car = only(sys, { s: 100, lateral: 2, speed: 30, dir: 1 });
    car.cruise = 30;
    // A slow rider a short way ahead, in the same lane.
    const r = createRacer({ id: 1, s: 118, lateral: 2, speed: 8 });
    let braked = false;
    for (let i = 0; i < 120; i++) {
      // Rider crawls along; the car must tuck in behind rather than run them over.
      r.s += 8 * (1 / 60);
      sys.step(1 / 60, r.s, i / 60, [r]);
      if (car.brake > 0) braked = true;
    }
    expect(braked).toBe(true);
    expect(car.speed).toBeLessThan(30);
    // Never gets past the rider's back wheel.
    expect(car.s).toBeLessThan(r.s);
  });

  it('does not brake for riders in another lane', () => {
    const sys = build();
    const car = only(sys, { s: 100, lateral: -6, speed: 30, dir: 1 });
    car.cruise = 30;
    const r = createRacer({ id: 1, s: 118, lateral: 6, speed: 8 });
    for (let i = 0; i < 30; i++) sys.step(1 / 60, r.s, i / 60, [r]);
    expect(car.brake).toBe(0);
    expect(car.speed).toBeCloseTo(30, 1);
  });

  it('does not brake for oncoming riders - they pass on the other side', () => {
    const sys = build();
    const car = only(sys, { s: 100, lateral: -6, speed: 28, dir: -1 });
    car.cruise = 28;
    const r = createRacer({ id: 1, s: 90, lateral: -6, speed: 60 });
    for (let i = 0; i < 20; i++) sys.step(1 / 60, r.s, i / 60, [r]);
    expect(car.brake).toBe(0);
  });

  it('gets back up to speed once the road is clear', () => {
    const sys = build();
    const car = only(sys, { s: 100, lateral: 2, speed: 12, dir: 1 });
    car.cruise = 28;
    for (let i = 0; i < 300; i++) sys.step(1 / 60, 100, i / 60, []);
    expect(car.speed).toBeCloseTo(28, 0);
  });

  it('reports signed velocity for oncoming cars', () => {
    const t = build();
    const car = only(t, { dir: -1, speed: 25 });
    expect(TrafficSystem.velocity(car)).toBe(-25);
    car.dir = 1;
    expect(TrafficSystem.velocity(car)).toBe(25);
  });
});

describe('traffic collisions', () => {
  it('crashes the rider on a high closing-speed head-on impact', () => {
    const t = build();
    only(t, { s: 100, lateral: 0, speed: 20, dir: -1 });
    // Just touching the car's nose - contact is longitudinal, not lateral.
    const r = createRacer({ id: 1, s: 96.8, lateral: 0, speed: 60 });
    const events = collideWithTraffic([r], t);
    const crash = events.find((e) => e.type === 'crash');
    expect(crash).toBeDefined();
    expect(r.state).toBe('down');
    expect(r.health).toBe(HEALTH.max - HEALTH.crashDamage);
  });

  it('only scrapes when speeds are matched', () => {
    const t = build();
    only(t, { s: 100, lateral: 0.5, speed: 40, dir: 1 });
    const r = createRacer({ id: 1, s: 100, lateral: 0, speed: 42 });
    const events = collideWithTraffic([r], t);
    expect(events.some((e) => e.type === 'scrape')).toBe(true);
    expect(r.state).toBe('ride');
    expect(r.lateral).toBeLessThan(0); // shoved clear of the car
    expect(r.speed).toBeLessThan(42);
  });

  it('marks the boundary between a scrape and a crash at the configured speed', () => {
    const under = build();
    only(under, { s: 100, lateral: 0, speed: 40, dir: 1 });
    const a = createRacer({ id: 1, s: 96.8, lateral: 0, speed: 40 + CRASH.hardImpactSpeed - 1 });
    expect(collideWithTraffic([a], under).some((e) => e.type === 'scrape')).toBe(true);

    const over = build();
    only(over, { s: 100, lateral: 0, speed: 40, dir: 1 });
    const b = createRacer({ id: 2, s: 96.8, lateral: 0, speed: 40 + CRASH.hardImpactSpeed + 1 });
    expect(collideWithTraffic([b], over).some((e) => e.type === 'crash')).toBe(true);
  });

  it('sideswiping a car scrapes you but does not put you down', () => {
    const t = build();
    only(t, { s: 100, lateral: 0, speed: 20, dir: -1 });
    // Alongside the car and drifting into its flank at a huge closing speed:
    // contact is lateral, so it must not be treated as a head-on shunt.
    const r = createRacer({ id: 1, s: 100, lateral: 1.4, speed: 65 });
    const events = collideWithTraffic([r], t);
    expect(events.some((e) => e.type === 'scrape')).toBe(true);
    expect(events.some((e) => e.type === 'crash')).toBe(false);
    expect(r.state).toBe('ride');
  });

  it('ignores cars in another lane', () => {
    const t = build();
    only(t, { s: 100, lateral: 6, speed: 20, dir: 1 });
    const r = createRacer({ id: 1, s: 100, lateral: -6, speed: 60 });
    expect(collideWithTraffic([r], t)).toHaveLength(0);
    expect(r.state).toBe('ride');
  });

  it('leaves downed riders alone', () => {
    const t = build();
    only(t, { s: 100, lateral: 0, speed: 20, dir: -1 });
    const r = createRacer({ id: 1, s: 100, lateral: 0, speed: 60 });
    r.state = 'down';
    expect(collideWithTraffic([r], t)).toHaveLength(0);
  });

  it('uses the real length of large vehicles', () => {
    const bus = CAR_TYPES.find((c) => c.key === 'bus')!;
    const t = build();
    only(t, { s: 100, lateral: 0, speed: 10, dir: 1, type: bus });
    // 4 m behind the bus centre is still inside a 10.5 m bus.
    const r = createRacer({ id: 1, s: 96, lateral: 0, speed: 60 });
    expect(collideWithTraffic([r], t).length).toBeGreaterThan(0);
  });
});

describe('racer-on-racer contact', () => {
  it('separates overlapping riders', () => {
    const a = createRacer({ id: 1, s: 100, lateral: 0, speed: 50 });
    const b = createRacer({ id: 2, s: 100, lateral: 0.2, speed: 50 });
    const events = collideRacers([a, b]);
    expect(events.some((e) => e.type === 'bump')).toBe(true);
    expect(b.lateral - a.lateral).toBeGreaterThan(0.2);
  });

  it('reports contact once rather than every tick', () => {
    const a = createRacer({ id: 1, s: 100, lateral: 0, speed: 50 });
    const b = createRacer({ id: 2, s: 100, lateral: 0.2, speed: 50 });
    const first = collideRacers([a, b]);
    const second = collideRacers([a, b]);
    expect(first.filter((e) => e.type === 'bump')).toHaveLength(1);
    expect(second.filter((e) => e.type === 'bump')).toHaveLength(0);
  });

  it('ignores riders who are well apart', () => {
    const a = createRacer({ id: 1, s: 100, lateral: 0 });
    const b = createRacer({ id: 2, s: 100, lateral: 5 });
    expect(collideRacers([a, b])).toHaveLength(0);
  });
});

describe('cars vs. cars', () => {
  /** Two cars nose to tail in one lane, the trailing one much faster. */
  function convoy(leadSpeed: number, chaseSpeed: number, gap: number) {
    const track = new Track({ seed: 4, length: 4000 });
    const sys = new TrafficSystem(track, makeRng(9), { density: 1 });
    for (const c of sys.cars) c.active = false;
    const [lead, chase] = sys.cars;
    for (const [c, s, speed] of [[lead, 500 + gap, leadSpeed], [chase, 500, chaseSpeed]] as const) {
      c.active = true;
      c.dir = 1;
      c.laneIndex = 0;
      c.s = s;
      c.lateral = 3;
      c.speed = speed;
      c.cruise = speed;
      c.swerve = 0;
      c.brake = 0;
    }
    return { sys, lead, chase };
  }

  it('brakes rather than driving through the car in front', () => {
    const { sys, lead, chase } = convoy(10, 30, 26);
    for (let i = 0; i < 240; i++) sys.step(1 / 60, 400, i / 60);
    expect(chase.speed).toBeLessThanOrEqual(lead.speed + 0.5);
    expect(lead.s - chase.s).toBeGreaterThan(0);
  });

  it('never lets two cars end a frame inside each other', () => {
    const { sys, lead, chase } = convoy(6, 34, 12);
    let worst = Infinity;
    for (let i = 0; i < 600; i++) {
      sys.step(1 / 60, 400, i / 60);
      if (!lead.active || !chase.active) break;
      const bumper = (lead.s - chase.s) - (lead.type.length + chase.type.length) / 2;
      worst = Math.min(worst, bumper);
    }
    expect(worst).toBeGreaterThanOrEqual(0);
  });

  it('leaves cars in other lanes alone', () => {
    const { sys, lead, chase } = convoy(8, 32, 20);
    chase.lateral = lead.lateral + 6; // a whole lane across
    for (let i = 0; i < 90; i++) {
      // Hold them apart laterally; the lane drift would otherwise close it.
      chase.lateral = lead.lateral + 6;
      sys.step(1 / 60, 400, i / 60);
      chase.lateral = lead.lateral + 6;
    }
    expect(chase.brake).toBe(0);
  });

  it('ignores oncoming traffic, which is in the other carriageway', () => {
    const { sys, lead, chase } = convoy(12, 30, 24);
    lead.dir = -1;
    for (let i = 0; i < 30; i++) sys.step(1 / 60, 400, i / 60);
    expect(chase.brake).toBe(0);
  });
});

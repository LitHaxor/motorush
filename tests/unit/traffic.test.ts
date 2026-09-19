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

  it('reports signed velocity for oncoming cars', () => {
    const t = build();
    const car = only(t, { dir: -1, speed: 25 });
    expect(TrafficSystem.velocity(car)).toBe(-25);
    car.dir = 1;
    expect(TrafficSystem.velocity(car)).toBe(25);
  });
});

describe('traffic collisions', () => {
  it('crashes the rider on a high closing-speed impact', () => {
    const t = build();
    only(t, { s: 100, lateral: 0, speed: 20, dir: -1 });
    const r = createRacer({ id: 1, s: 100, lateral: 0, speed: 60 });
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
    const a = createRacer({ id: 1, s: 100, lateral: 0, speed: 40 + CRASH.hardImpactSpeed - 1 });
    expect(collideWithTraffic([a], under).some((e) => e.type === 'scrape')).toBe(true);

    const over = build();
    only(over, { s: 100, lateral: 0, speed: 40, dir: 1 });
    const b = createRacer({ id: 2, s: 100, lateral: 0, speed: 40 + CRASH.hardImpactSpeed + 1 });
    expect(collideWithTraffic([b], over).some((e) => e.type === 'crash')).toBe(true);
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

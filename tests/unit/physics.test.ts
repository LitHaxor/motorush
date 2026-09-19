import { describe, it, expect } from 'vitest';
import { Track } from '../../src/sim/track';
import { createRacer, speedCap, knockDown } from '../../src/sim/racer';
import { stepRacer, corneringDrift, steerAuthority, NEUTRAL_INPUT } from '../../src/sim/physics';
import { BIKE, HEALTH, TRACK } from '../../src/sim/config';
import type { RacerInput } from '../../src/sim/types';

const track = new Track({ seed: 4, length: 3000 });
const input = (over: Partial<RacerInput> = {}): RacerInput => ({ ...NEUTRAL_INPUT, ...over });
const run = (r: Parameters<typeof stepRacer>[0], inp: RacerInput, seconds: number, ctx = {}) => {
  const events = [];
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) events.push(...stepRacer(r, track, inp, dt, ctx));
  return events;
};

describe('physics: longitudinal', () => {
  it('accelerates toward the cap but never past it', () => {
    const r = createRacer({ id: 1, kind: 'player' });
    run(r, input({ throttle: 1 }), 20);
    const cap = speedCap(r, track);
    expect(r.speed).toBeGreaterThan(cap * 0.9);
    expect(r.speed).toBeLessThanOrEqual(cap * 1.02 + 1e-9);
  });

  it('reaches a usable speed within a few seconds', () => {
    const r = createRacer({ id: 1, kind: 'player' });
    run(r, input({ throttle: 1 }), 5);
    // Should be well into triple-digit km/h by 5s or the game feels sluggish.
    expect(r.speed * 3.6).toBeGreaterThan(140);
  });

  it('brakes harder than it coasts', () => {
    const coasting = createRacer({ id: 1, speed: 60 });
    const braking = createRacer({ id: 2, speed: 60 });
    run(coasting, input({ throttle: 0 }), 1);
    run(braking, input({ throttle: 0, brake: 1 }), 1);
    expect(braking.speed).toBeLessThan(coasting.speed);
    expect(coasting.speed).toBeLessThan(60);
  });

  it('never drives backwards', () => {
    const r = createRacer({ id: 1, speed: 5 });
    run(r, input({ brake: 1 }), 5);
    expect(r.speed).toBe(0);
  });

  it('caps speed lower once off the asphalt', () => {
    const onRoad = createRacer({ id: 1, lateral: 0 });
    const offRoad = createRacer({ id: 2, lateral: TRACK.halfWidth + 2 });
    expect(speedCap(offRoad, track)).toBeLessThan(speedCap(onRoad, track) * 0.6);
  });

  it('gives a higher cap while boosting', () => {
    const r = createRacer({ id: 1 });
    const base = speedCap(r, track);
    r.boostTimer = 2;
    expect(speedCap(r, track)).toBeCloseTo(base * BIKE.boostMultiplier);
  });

  it('costs top speed when badly hurt', () => {
    const r = createRacer({ id: 1 });
    const healthy = speedCap(r, track);
    r.health = 10;
    expect(speedCap(r, track)).toBeLessThan(healthy);
  });
});

describe('physics: lateral', () => {
  it('scales steering authority with speed', () => {
    expect(steerAuthority(0)).toBeCloseTo(BIKE.steerLowSpeed);
    expect(steerAuthority(BIKE.maxSpeed)).toBeCloseTo(1);
    expect(steerAuthority(30)).toBeGreaterThan(steerAuthority(5));
    expect(steerAuthority(1e9)).toBeLessThanOrEqual(1);
  });

  it('pushes toward the outside of a corner, quadratically in speed', () => {
    // Positive curvature is a left turn, so drift is to the rider's right.
    expect(corneringDrift(0.004, 60)).toBeGreaterThan(0);
    expect(corneringDrift(-0.004, 60)).toBeLessThan(0);
    expect(corneringDrift(0.004, 60)).toBeCloseTo(corneringDrift(0.004, 30) * 4, 5);
    expect(corneringDrift(0, 60)).toBe(0);
  });

  it('steers right on positive input', () => {
    const r = createRacer({ id: 1, speed: 40, lateral: 0 });
    run(r, input({ throttle: 1, steer: 1 }), 0.5);
    expect(r.lateral).toBeGreaterThan(0);
  });

  it('crashes into the scenery past the shoulder', () => {
    const r = createRacer({ id: 1, speed: 40, lateral: TRACK.halfWidth + TRACK.shoulder - 0.2 });
    const events = run(r, input({ throttle: 1, steer: 1 }), 1);
    const crash = events.find((e) => e.type === 'crash');
    expect(crash).toBeDefined();
    expect(crash && 'cause' in crash && crash.cause).toBe('barrier');
    expect(r.state).toBe('down');
    expect(r.health).toBe(HEALTH.max - HEALTH.barrierDamage);
  });
});

describe('physics: state machine', () => {
  it('remounts after a crash and loses ground doing it', () => {
    const r = createRacer({ id: 1, speed: 50, s: 400 });
    const sBefore = r.s;
    knockDown(r, 1);
    expect(r.state).toBe('down');

    // Step until the remount fires so we sample speed at that instant, not
    // after another second of acceleration.
    let remounted = false;
    let speedAtRemount = 0;
    for (let i = 0; i < 600 && !remounted; i++) {
      for (const e of stepRacer(r, track, input({ throttle: 1 }), 1 / 60)) {
        if (e.type === 'remount') {
          remounted = true;
          speedAtRemount = r.speed;
        }
      }
    }
    expect(remounted).toBe(true);
    expect(r.state).toBe('ride');
    expect(speedAtRemount).toBeLessThan(15); // back on the bike, but slowly
    // Going down should cost ground, not gain it.
    expect(r.s).toBeLessThan(sBefore + 40);
  });

  it('pulls a crashed rider back onto the road', () => {
    const r = createRacer({ id: 1, speed: 30, lateral: TRACK.halfWidth + 3 });
    knockDown(r, 1);
    run(r, input(), 5);
    expect(Math.abs(r.lateral)).toBeLessThan(TRACK.halfWidth);
  });

  it('emits finish exactly once at the line', () => {
    const r = createRacer({ id: 1, speed: 60, s: 990 });
    const events = run(r, input({ throttle: 1 }), 3, { raceDistance: 1000, elapsed: 12 });
    const finishes = events.filter((e) => e.type === 'finish');
    expect(finishes).toHaveLength(1);
    expect(r.state).toBe('finished');
    expect(r.finishTime).toBe(12);
  });

  it('regenerates health only after the grace period', () => {
    const r = createRacer({ id: 1 });
    r.health = 50;
    r.sinceDamage = 0;
    run(r, input(), 1);
    expect(r.health).toBe(50); // still inside the delay
    run(r, input(), 6);
    expect(r.health).toBeGreaterThan(50);
  });

  it('drops an expired weapon back to fists', () => {
    const r = createRacer({ id: 1 });
    r.weapon = 'club';
    r.weaponTimer = 0.5;
    run(r, input(), 1);
    expect(r.weapon).toBe('fist');
  });

  it('tracks the best speed reached', () => {
    const r = createRacer({ id: 1 });
    run(r, input({ throttle: 1 }), 10);
    const peak = r.speed;
    run(r, input({ brake: 1 }), 3);
    expect(r.bestSpeed).toBeGreaterThanOrEqual(peak);
  });
});

describe('physics: going down and getting back up', () => {
  it('slides further the faster you were going', () => {
    const measure = (speed: number) => {
      const r = createRacer({ id: 1, speed, s: 500 });
      const start = r.s;
      knockDown(r, 1);
      // Ride out the tumble without the rider hustling.
      for (let i = 0; i < 60 * 3; i++) {
        stepRacer(r, track, input({ throttle: 0 }), 1 / 60);
        if (r.state !== 'down') break;
      }
      return r.s - start;
    };
    const slow = measure(15);
    const fast = measure(65);
    expect(fast).toBeGreaterThan(slow * 2);
    // But you never keep sliding forever.
    expect(fast).toBeLessThan(60);
  });

  it('keeps most of your speed on impact rather than stopping dead', () => {
    const r = createRacer({ id: 1, speed: 60 });
    knockDown(r, 1);
    expect(r.speed).toBeGreaterThan(20);
    expect(r.speed).toBeLessThan(60);
  });

  it('keeps you down longer after a heavier crash', () => {
    const light = createRacer({ id: 1, speed: 30 });
    const heavy = createRacer({ id: 2, speed: 30 });
    knockDown(light, 0);
    knockDown(heavy, 1);
    expect(heavy.downTimer).toBeGreaterThan(light.downTimer);
  });

  it('lets the player hustle back to the bike by holding the throttle', () => {
    const timeToRemount = (throttle: number) => {
      const r = createRacer({ id: 1, speed: 40, s: 300 });
      knockDown(r, 0.8);
      let t = 0;
      for (let i = 0; i < 60 * 12; i++) {
        t += 1 / 60;
        stepRacer(r, track, input({ throttle }), 1 / 60);
        if (r.state === 'ride') return t;
      }
      return Infinity;
    };
    const passive = timeToRemount(0);
    const hustling = timeToRemount(1);
    expect(hustling).toBeLessThan(passive);
    // The rider still gets up on their own without any input.
    expect(passive).toBeLessThan(6);
  });
});

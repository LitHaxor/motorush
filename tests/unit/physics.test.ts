import { describe, it, expect } from 'vitest';
import { Track } from '../../src/sim/track';
import { buildBiomes, buildRoadLayout } from '../../src/sim/biomes';
import { makeRng } from '../../src/sim/mathx';
import { createRacer, speedCap, knockDown } from '../../src/sim/racer';
import { stepRacer, corneringDrift, steerAuthority, NEUTRAL_INPUT } from '../../src/sim/physics';
import { BIKE, CRASH, HEALTH, TRACK } from '../../src/sim/config';
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

describe('physics: the crash recovery sequence', () => {
  /** Record the order of rider phases through a whole get-off. */
  const phaseOrder = (speed: number, throttle = 0) => {
    const r = createRacer({ id: 1, speed, s: 400 });
    knockDown(r, 0.8);
    const seen: string[] = [r.riderPhase];
    for (let i = 0; i < 60 * 25; i++) {
      stepRacer(r, track, input({ throttle }), 1 / 60);
      // Stop before recording the reset that remount() does for the next crash.
      if (r.state === 'ride') break;
      if (seen[seen.length - 1] !== r.riderPhase) seen.push(r.riderPhase);
    }
    return { seen, racer: r };
  };

  it('runs fall -> stand -> walk back -> lift the bike -> mount, in order', () => {
    const { seen, racer } = phaseOrder(45);
    expect(seen).toEqual(['tumble', 'standing', 'running', 'lifting', 'mounting']);
    expect(racer.state).toBe('ride');
  });

  it('slides further, and so takes longer, the faster the crash', () => {
    const timeFor = (speed: number) => {
      const r = createRacer({ id: 1, speed, s: 400 });
      knockDown(r, 1);
      let t = 0;
      for (let i = 0; i < 60 * 30; i++) {
        t += 1 / 60;
        stepRacer(r, track, input({ throttle: 0 }), 1 / 60);
        if (r.state === 'ride') break;
      }
      return t;
    };
    const slow = timeFor(12);
    const fast = timeFor(68);
    expect(fast).toBeGreaterThan(slow);
    // But a get-off never costs an unreasonable amount of time.
    expect(fast).toBeLessThan(12);
  });

  it('throws the rider a distance set by speed, not at random', () => {
    const throwFor = (speed: number) => {
      const r = createRacer({ id: 1, speed });
      knockDown(r, 1);
      return r.riderThrowTarget;
    };
    // Deterministic: the same crash speed always gives the same distance.
    expect(throwFor(50)).toBe(throwFor(50));
    expect(throwFor(65)).toBeGreaterThan(throwFor(20));
  });

  it('reaches the bike before trying to pick it up', () => {
    const r = createRacer({ id: 1, speed: 60, s: 400 });
    knockDown(r, 1);
    for (let i = 0; i < 60 * 30; i++) {
      stepRacer(r, track, input({ throttle: 0 }), 1 / 60);
      if (r.riderPhase === 'lifting') break;
    }
    expect(r.riderPhase).toBe('lifting');
    // You cannot pick up a bike you are not standing next to.
    expect(r.riderThrow).toBeLessThanOrEqual(0.05);
    expect(Math.abs(r.riderLateralThrow)).toBeLessThan(0.4);
  });

  it('lets the player hurry every stage by holding the throttle', () => {
    const timeFor = (throttle: number) => {
      const r = createRacer({ id: 1, speed: 50, s: 400 });
      knockDown(r, 0.8);
      let t = 0;
      for (let i = 0; i < 60 * 30; i++) {
        t += 1 / 60;
        stepRacer(r, track, input({ throttle }), 1 / 60);
        if (r.state === 'ride') break;
      }
      return t;
    };
    expect(timeFor(1)).toBeLessThan(timeFor(0));
  });
});

describe('physics: hitting the barrier', () => {
  const edge = TRACK.halfWidth + TRACK.shoulder;

  it('does not bin you for touching a guardrail at walking pace', () => {
    const r = createRacer({ id: 1, speed: 6, lateral: edge - 0.1 });
    const events = run(r, input({ throttle: 0, steer: 1 }), 1.5);
    expect(r.state).toBe('ride');
    expect(events.some((e) => e.type === 'crash')).toBe(false);
    expect(events.some((e) => e.type === 'scrape')).toBe(true);
    // Pushed back inside the corridor rather than left stuck in it.
    expect(Math.abs(r.lateral)).toBeLessThanOrEqual(edge + 1e-6);
  });

  it('still throws you off if you hit it at speed', () => {
    const r = createRacer({ id: 1, speed: 55, lateral: edge - 0.1 });
    const events = run(r, input({ throttle: 1, steer: 1 }), 1);
    expect(r.state).toBe('down');
    const crash = events.find((e) => e.type === 'crash');
    expect(crash && 'cause' in crash && crash.cause).toBe('barrier');
  });

  it('scrubs speed on a low-speed scrape', () => {
    const r = createRacer({ id: 1, speed: 12, lateral: edge - 0.05 });
    run(r, input({ throttle: 0, steer: 1 }), 0.3);
    expect(r.speed).toBeLessThan(12);
    expect(r.state).toBe('ride');
  });

  it('marks the boundary at the configured speed', () => {
    const under = createRacer({ id: 1, speed: CRASH.barrierCrashSpeed - 3, lateral: edge - 0.05 });
    run(under, input({ throttle: 0, steer: 1 }), 0.3);
    expect(under.state).toBe('ride');

    const over = createRacer({ id: 2, speed: CRASH.barrierCrashSpeed + 5, lateral: edge - 0.05 });
    run(over, input({ throttle: 0, steer: 1 }), 0.3);
    expect(over.state).toBe('down');
  });
});

describe('physics: a split opening underneath you', () => {
  /** A track with a fork, laid out the way the World does it. */
  const forkTrack = () => {
    for (let seed = 1; seed < 80; seed++) {
      const rng = makeRng(seed);
      const biomes = buildBiomes(12000, rng);
      const divided = buildRoadLayout(12000, rng, biomes, {
        medianHalfWidth: TRACK.medianHalfWidth,
        forkHalfWidth: TRACK.forkHalfWidth,
        forkChance: TRACK.forkChance,
        medianLength: TRACK.medianLength,
        forkLength: TRACK.forkLength,
        gap: TRACK.medianGap,
        cityMargin: TRACK.splitBiomeMargin,
      });
      const fork = divided.find((d) => d.fork);
      if (fork) return { track: new Track({ seed, length: 12000, biomes, divided }), fork };
    }
    throw new Error('no fork generated');
  };

  it('carries a rider out with their lane as the median opens', () => {
    const { track: tk, fork } = forkTrack();
    const r = createRacer({ id: 1, speed: 55, lateral: 4.5 });
    // Start well before the split and ride straight through the ramp.
    r.s = fork.from - TRACK.medianRamp - 60;
    for (let i = 0; i < 60 * 12; i++) {
      stepRacer(r, tk, { ...NEUTRAL_INPUT, throttle: 1 }, 1 / 60);
      if (r.s > fork.from + 60) break;
    }
    // Still on tarmac, on the same side, rather than stranded on the island.
    expect(r.state).toBe('ride');
    expect(tk.isOffRoad(r.lateral, r.s)).toBe(false);
    expect(r.lateral).toBeGreaterThan(tk.medianAt(r.s));
  });

  it('does not shove anyone sideways where the road is undivided', () => {
    const { track: tk } = forkTrack();
    const r = createRacer({ id: 1, speed: 50, lateral: 3 });
    r.s = 50;
    const before = r.lateral;
    for (let i = 0; i < 60; i++) {
      stepRacer(r, tk, { ...NEUTRAL_INPUT, throttle: 1 }, 1 / 60);
    }
    // Only cornering drift should have moved them, and barely on the straight.
    expect(Math.abs(r.lateral - before)).toBeLessThan(0.5);
  });

  it('keeps a rider on the left carriageway on the left', () => {
    const { track: tk, fork } = forkTrack();
    const r = createRacer({ id: 1, speed: 55, lateral: -4.5 });
    r.s = fork.from - TRACK.medianRamp - 60;
    for (let i = 0; i < 60 * 12; i++) {
      stepRacer(r, tk, { ...NEUTRAL_INPUT, throttle: 1 }, 1 / 60);
      if (r.s > fork.from + 60) break;
    }
    expect(r.lateral).toBeLessThan(-tk.medianAt(r.s));
    expect(tk.isOffRoad(r.lateral, r.s)).toBe(false);
  });
});

describe('physics: getting going again', () => {
  const edge = TRACK.halfWidth + TRACK.shoulder;

  it('lets a rider pinned against the barrier pull away', () => {
    // Stopped, hard against the rail, throttle pinned. This used to leave the
    // bike revving on the spot: the out-of-bounds branch returned before the
    // odometry ran, so speed climbed but distance never did.
    const r = createRacer({ id: 1, speed: 0, lateral: edge + 0.5, s: 400 });
    const startS = r.s;
    run(r, input({ throttle: 1 }), 3);
    expect(r.state).toBe('ride');
    expect(r.s).toBeGreaterThan(startS + 10);
    expect(r.speed).toBeGreaterThan(5);
  });

  it('pulls away from a standstill out on the verge', () => {
    const r = createRacer({ id: 1, speed: 0, lateral: TRACK.halfWidth + 2, s: 400 });
    const startS = r.s;
    run(r, input({ throttle: 1 }), 3);
    expect(r.s).toBeGreaterThan(startS + 15);
  });

  it('nudges a barrier-scraping rider back toward the road', () => {
    const r = createRacer({ id: 1, speed: 4, lateral: edge + 0.4, s: 400 });
    run(r, input({ throttle: 1 }), 2);
    expect(Math.abs(r.lateral)).toBeLessThan(edge + 0.1);
  });
});

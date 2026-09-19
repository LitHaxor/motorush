import { describe, it, expect } from 'vitest';
import { World, COUNTDOWN_TIME } from '../../src/sim/world';
import { knockDown } from '../../src/sim/racer';
import { POLICE, DIFFICULTY, CRASH } from '../../src/sim/config';
import { parkSpotBeside } from '../../src/sim/ai';
import type { DifficultyKey, RacerInput, SimEvent } from '../../src/sim/types';

const DT = 1 / 60;
const INPUT = (over: Partial<RacerInput> = {}): RacerInput => ({
  throttle: 0, brake: 0, steer: 0, attackLeft: false, attackRight: false, ...over,
});

/** Run out the countdown. Returns everything the sim emitted along the way. */
function startRace(w: World, input = INPUT()): SimEvent[] {
  const events: SimEvent[] = [];
  let guard = 0;
  while (w.state === 'countdown' && guard++ < 1000) events.push(...w.step(DT, input));
  return events;
}

function race(w: World, seconds: number, input = INPUT({ throttle: 1 })): SimEvent[] {
  const events: SimEvent[] = [];
  for (let t = 0; t < seconds && !w.isOver; t += DT) events.push(...w.step(DT, input));
  return events;
}

describe('World: setup', () => {
  it('builds a full grid with the player on it', () => {
    const w = new World({ seed: 5 });
    expect(w.racers).toHaveLength(8); // player + 7 rivals
    expect(w.racers[0]).toBe(w.player);
    expect(w.player.kind).toBe('player');
    expect(w.rivals.every((r) => r.kind === 'rival' && r.ai)).toBe(true);
    // Every rival gets a distinct name.
    const names = new Set(w.rivals.map((r) => r.name));
    expect(names.size).toBe(w.rivals.length);
  });

  it('honours the difficulty preset', () => {
    expect(new World({ difficulty: 'easy' }).raceDistance).toBe(DIFFICULTY.easy.distance);
    expect(new World({ difficulty: 'hard' }).raceDistance).toBe(DIFFICULTY.hard.distance);
    expect(new World({ difficulty: 'hard' }).traffic.cars.length)
      .toBeGreaterThan(new World({ difficulty: 'easy' }).traffic.cars.length);
  });

  it('lines the grid up behind the player without overlaps', () => {
    const w = new World({ seed: 5 });
    expect(w.player.s).toBe(0);
    // No two bikes may share a grid slot.
    const slots = new Set(w.racers.map((r) => `${r.s.toFixed(2)}:${r.lateral.toFixed(2)}`));
    expect(slots.size).toBe(w.racers.length);
    expect(w.rivals.every((r) => r.s <= 0)).toBe(true);
    expect(w.traffic.cars.every((c) => c.active)).toBe(true);
  });
});

describe('World: countdown', () => {
  it('counts down and releases the field', () => {
    const w = new World({ seed: 1 });
    expect(w.state).toBe('countdown');
    const events = startRace(w);
    const lights = events.filter((e) => e.type === 'countdown').map((e) => (e as { value: number }).value);
    expect(lights).toEqual([3, 2, 1, 0]);
    expect(events.some((e) => e.type === 'go')).toBe(true);
    expect(w.state).toBe('racing');
    expect(w.elapsed).toBe(0); // the clock starts at GO, not before
  });

  it('holds the field still until the lights go out', () => {
    const w = new World({ seed: 1 });
    for (let t = 0; t < COUNTDOWN_TIME - 0.2; t += DT) w.step(DT, INPUT({ throttle: 1 }));
    expect(w.player.s).toBe(0);
    expect(w.player.speed).toBe(0);
  });

  it('rewards holding the throttle as the lights go out', () => {
    const w = new World({ seed: 1 });
    const events = startRace(w, INPUT({ throttle: 1 }));
    expect(events.some((e) => e.type === 'holeshot')).toBe(true);
    expect(w.player.boostTimer).toBeGreaterThan(0);
  });

  it('punishes jumping the start', () => {
    const w = new World({ seed: 1 });
    const events: SimEvent[] = [];
    // On the gas early, off it late: no launch boost.
    for (let t = 0; t < COUNTDOWN_TIME + 0.1; t += DT) {
      const early = w.countdown > 1.0;
      events.push(...w.step(DT, INPUT({ throttle: early ? 1 : 0 })));
    }
    expect(events.some((e) => e.type === 'holeshot')).toBe(false);
    expect(w.player.boostTimer).toBe(0);
  });
});

describe('World: determinism', () => {
  it('produces identical races from the same seed and inputs', () => {
    const scripted = (i: number) => INPUT({ throttle: 1, steer: Math.sin(i / 30) * 0.5 });
    const play = (seed: number) => {
      const w = new World({ seed });
      startRace(w);
      for (let i = 0; i < 60 * 25 && !w.isOver; i++) w.step(DT, scripted(i));
      return w;
    };
    const a = play(99);
    const b = play(99);
    expect(a.player.s).toBe(b.player.s);
    expect(a.player.health).toBe(b.player.health);
    expect(a.rivals.map((r) => r.s)).toEqual(b.rivals.map((r) => r.s));
    expect(a.traffic.cars.map((c) => c.s)).toEqual(b.traffic.cars.map((c) => c.s));

    const c = play(100);
    expect(c.player.s).not.toBe(a.player.s);
  });
});

describe('World: standings', () => {
  it('ranks by distance while the race is live', () => {
    const w = new World({ seed: 3 });
    startRace(w);
    w.player.s = 900;
    w.rivals[0].s = 1200;
    w.rivals[1].s = 400;
    w.updateStandings();
    expect(w.rivals[0].place).toBe(1);
    expect(w.player.place).toBe(2);
    expect(w.standings[0]).toBe(w.rivals[0]);
  });

  it('ranks finishers ahead of everyone still riding, by time', () => {
    const w = new World({ seed: 3 });
    startRace(w);
    w.player.s = 99999;
    w.rivals[0].finishTime = 80;
    w.rivals[1].finishTime = 60;
    w.updateStandings();
    expect(w.rivals[1].place).toBe(1);
    expect(w.rivals[0].place).toBe(2);
    expect(w.player.place).toBe(3); // furthest of those still riding
  });
});

describe('World: outcomes', () => {
  it('finishes the race and reports a result', () => {
    const w = new World({ seed: 7 });
    startRace(w);
    w.player.s = w.raceDistance - 5;
    const events = race(w, 5, INPUT({ throttle: 1 }));
    expect(w.state).toBe('finished');
    expect(events.some((e) => e.type === 'raceEnd')).toBe(true);
    expect(w.result).toBeTruthy();
    expect(w.result!.reason).toBe('finished');
    expect(w.result!.place).toBe(w.player.place);
    expect(w.result!.standings).toHaveLength(8);
    expect(w.result!.raceDistance).toBe(w.raceDistance);
  });

  it('wastes the player when health runs out', () => {
    const w = new World({ seed: 7 });
    startRace(w);
    w.player.health = 0;
    const events = race(w, 0.5, INPUT({ throttle: 1 }));
    expect(w.state).toBe('wasted');
    const end = events.find((e) => e.type === 'raceEnd');
    expect(end && 'reason' in end && end.reason).toBe('wasted');
  });

  it('keeps the world alive after the race ends without re-firing events', () => {
    const w = new World({ seed: 7 });
    startRace(w);
    w.player.health = 0;
    race(w, 0.5);
    const sBefore = w.rivals[0].s;
    const after = w.step(DT * 30, INPUT());
    expect(after).toHaveLength(0);
    expect(w.rivals[0].s).toBeGreaterThan(sBefore); // rivals ride on
  });

  it('clamps progress to 0..1', () => {
    const w = new World({ seed: 7 });
    expect(w.progress).toBe(0);
    w.player.s = w.raceDistance * 2;
    expect(w.progress).toBe(1);
  });

  it('only accepts attacks while actually racing', () => {
    const w = new World({ seed: 7 });
    expect(w.requestAttack(1)).toBe(false); // still on the countdown
    startRace(w);
    expect(w.requestAttack(1)).toBe(true);
    expect(w.requestAttack(1)).toBe(false); // cooldown
  });
});

describe('World: police', () => {
  // Sit right on the cap rather than just under it: these tests are about what
  // happens when heat maxes out, not about how fast it gets there, and leaving
  // the last half-point to accrue made them silently dependent on the
  // POLICE.speedHeat tuning value.
  const heatUp = (w: World) => {
    w.heat = POLICE.heatMax;
    w.player.speed = POLICE.speedThreshold + 20;
  };

  it('builds heat only above the speed threshold', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    w.player.speed = POLICE.speedThreshold - 10;
    w.heat = 20;
    race(w, 1, INPUT({ throttle: 0 }));
    expect(w.heat).toBeLessThan(20); // cools off when you behave

    const hot = new World({ seed: 11 });
    startRace(hot);
    hot.heat = 20;
    hot.player.speed = POLICE.speedThreshold + 20;
    hot.step(DT, INPUT({ throttle: 1 }));
    expect(hot.heat).toBeGreaterThan(20);
  });

  it('sends a cop once heat maxes out', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    heatUp(w);
    const events = race(w, 0.2, INPUT({ throttle: 1 }));
    expect(events.some((e) => e.type === 'copSpawn')).toBe(true);
    expect(w.cop).toBeTruthy();
    expect(w.cop!.weapon).toBe('baton');
    expect(w.cop!.s).toBeLessThan(w.player.s); // arrives from behind
    expect(w.field).toContain(w.cop);
  });


  it('arrests you once you go down with a patrol on you', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    const cop = w.spawnCop();
    // Put the player on the tarmac right in front of them.
    knockDown(w.player, 1);
    for (let i = 0; i < 60 * 8 && !w.isOver; i++) {
      cop.s = w.player.s - 6;
      cop.lateral = w.player.lateral + 2;
      w.step(DT, INPUT({ throttle: 1 }));
    }

    expect(w.state).toBe('busted');
    expect(w.player.state).toBe('busted');
    expect(w.result!.reason).toBe('busted');
  });

  it('gives you no way to wait the patrol out on the ground', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    const cop = w.spawnCop();
    knockDown(w.player, 1);
    let elapsed = 0;
    for (let i = 0; i < 60 * 12 && !w.isOver; i++) {
      cop.s = w.player.s - 6;
      // Never touch the throttle: the rider dawdles back to the bike.
      w.step(DT, INPUT({ throttle: 0 }));
      elapsed += DT;
    }
    expect(w.state).toBe('busted');
    expect(elapsed).toBeLessThan(POLICE.arrestPatience + 2);
  });

  it('cannot arrest you while you are still upright', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    const cop = w.spawnCop();
    for (let i = 0; i < 60 * 4 && !w.isOver; i++) {
      // Keep the road clear and hold the racing line: crashing into traffic or
      // drifting into the barrier would both be fair arrests, and would stop
      // this testing what it claims to.
      for (const car of w.traffic.cars) car.s = w.player.s + 500;
      w.player.lateral = 2;
      // Keep them healthy too: a cop CAN baton you off the bike and then
      // arrest you, which is a fair bust. This test is only about whether
      // riding alongside is enough on its own.
      w.player.health = w.player.maxHealth;
      cop.s = w.player.s;
      cop.lateral = w.player.lateral + 2;
      w.step(DT, INPUT({ throttle: 1 }));
    }
    expect(w.state).toBe('racing');
    expect(w.player.state).not.toBe('busted');
  });

  it('lets a patrol baton you off the bike and then arrest you', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    const cop = w.spawnCop();
    w.player.health = 8; // one baton hit from going down
    for (let i = 0; i < 60 * 6 && !w.isOver; i++) {
      for (const car of w.traffic.cars) car.s = w.player.s + 500;
      w.player.lateral = 2;
      cop.s = w.player.s;
      cop.lateral = w.player.lateral + 1.6;
      w.step(DT, INPUT({ throttle: 1 }));
    }
    expect(w.state).toBe('busted');
  });

  it('does not arrest you if you crash far from the patrol', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    const cop = w.spawnCop();
    cop.s = w.player.s - 140;
    knockDown(w.player, 1);
    w.step(DT, INPUT({ throttle: 0 }));
    expect(w.state).toBe('racing');
  });

  it('reports how close the patrol is for the HUD', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    const cop = w.spawnCop();
    cop.s = w.player.s - 200;
    w.step(DT, INPUT({ throttle: 1 }));
    const far = w.bustProgress;
    cop.s = w.player.s - 5;
    w.step(DT, INPUT({ throttle: 1 }));
    expect(w.bustProgress).toBeGreaterThan(far);
    expect(w.bustProgress).toBeLessThanOrEqual(1);
  });

  it('breaks off the pursuit once you open up a big enough lead', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    const cop = w.spawnCop();
    const events: SimEvent[] = [];
    for (let i = 0; i < 60 * 4 && w.cop; i++) {
      cop.s = w.player.s - POLICE.escapeDistance - 50;
      events.push(...w.step(DT, INPUT({ throttle: 1 })));
    }
    const gaveUp = events.find((e) => e.type === 'copGiveUp');
    expect(gaveUp && 'reason' in gaveUp && gaveUp.reason).toBe('outrun');
    expect(w.cop).toBeNull();
    expect(w.heat).toBe(0);
  });

  it('breaks off the pursuit if you put the cop down enough times', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    const cop = w.spawnCop();
    cop.knockdowns = POLICE.giveUpKnockdowns;
    const events = race(w, 0.2, INPUT({ throttle: 1 }));
    const gaveUp = events.find((e) => e.type === 'copGiveUp');
    expect(gaveUp && 'reason' in gaveUp && gaveUp.reason).toBe('beaten');
    expect(w.cop).toBeNull();
  });

  it('does not stack cops', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    heatUp(w);
    race(w, 0.2, INPUT({ throttle: 1 }));
    const first = w.cop;
    w.addHeat(500);
    race(w, 0.5, INPUT({ throttle: 1 }));
    expect(w.cop).toBe(first);
  });
});

describe('World: arrest vs. wasted', () => {
  it('reads as BUSTED when a patrol is on the scene as you go down', () => {
    const w = new World({ seed: 21 });
    startRace(w);
    const cop = w.spawnCop();
    cop.s = w.player.s - 4;
    // Health hits zero on the same tick the cop is alongside.
    w.player.health = 0;
    w.step(DT, INPUT({ throttle: 1 }));
    expect(w.state).toBe('busted');
  });

  it('reads as WASTED when there is no patrol around', () => {
    const w = new World({ seed: 21 });
    startRace(w);
    w.player.health = 0;
    w.step(DT, INPUT({ throttle: 1 }));
    expect(w.state).toBe('wasted');
  });
});

describe('World: police pressure by difficulty', () => {
  // Tested through addHeat rather than by riding fast for a while: harder
  // settings also carry more traffic, so a speed-based test ends up measuring
  // how often the rider crashes rather than how fast heat builds.
  it('scales heat by difficulty', () => {
    const gain = (difficulty: DifficultyKey) => {
      const w = new World({ seed: 5, difficulty });
      startRace(w);
      w.addHeat(10);
      return w.heat;
    };
    expect(gain('hard')).toBeGreaterThan(gain('normal'));
    expect(gain('normal')).toBeGreaterThan(gain('easy'));
  });
});

describe('World: a patrol parks at the crash', () => {
  /** Put the player down with a cop right on them, and hold them down. */
  function downedWithCop(seed = 11) {
    const w = new World({ seed });
    startRace(w);
    const cop = w.spawnCop();
    cop.s = w.player.s - 5;
    cop.lateral = w.player.lateral;
    cop.speed = 45;
    knockDown(w.player, 1);
    return { w, cop };
  }

  it('stops chasing and pulls up rather than riding on past', () => {
    const { w, cop } = downedWithCop();
    for (let i = 0; i < 60 * 3 && !w.isOver; i++) {
      // Keep the player on the deck so the arrest does not end it early.
      w.player.state = 'down';
      w.player.health = 100;
      w.step(DT, INPUT({ throttle: 0 }));
    }
    expect(w.arrestPending).toBe(true);
    expect(cop.speed).toBeLessThan(3);
    // Parked beside the rider, not a hundred metres up the road.
    expect(Math.abs(cop.s - w.player.s)).toBeLessThan(45);
  });

  it('pulls in to one side instead of stopping on top of the rider', () => {
    const { w, cop } = downedWithCop();
    for (let i = 0; i < 60 * 3 && !w.isOver; i++) {
      w.player.state = 'down';
      w.player.health = 100;
      w.step(DT, INPUT({ throttle: 0 }));
    }
    expect(Math.abs(cop.lateral - w.player.lateral)).toBeGreaterThan(1.2);
  });

  it('parks on the rider’s right when there is road on that side', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    w.player.lateral = 0;
    const spot = parkSpotBeside(w.player, w.track);
    expect(spot).toBeGreaterThan(0);
    expect(w.track.isOffRoad(spot, w.player.s)).toBe(false);
  });

  it('takes the left when the right would put it off the tarmac', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    w.player.lateral = w.track.edgeAt(w.player.s) - 0.4;
    const spot = parkSpotBeside(w.player, w.track);
    expect(spot).toBeLessThan(w.player.lateral);
    expect(w.track.isOffRoad(spot, w.player.s)).toBe(false);
  });

  it('creeps rather than riding off when it starts short of the spot', () => {
    // The gap the first attempt fell through: every other case starts the
    // patrol fast, so it only ever exercised braking. Starting it stopped a
    // few metres short is what exposes the throttle being a fraction of top
    // speed - an ungated creep pulled away from the crash at 75 km/h.
    const { w, cop } = downedWithCop();
    cop.speed = 0;
    cop.s = w.player.s - 6;
    let fastest = 0;
    for (let i = 0; i < 60 * 4 && !w.isOver; i++) {
      w.player.state = 'down';
      w.player.health = 100;
      w.player.speed = 0;
      w.step(DT, INPUT({ throttle: 0 }));
      fastest = Math.max(fastest, cop.speed);
    }
    expect(fastest).toBeLessThan(POLICE.parkCreepSpeed * 2);
    expect(Math.abs(cop.s - w.player.s)).toBeLessThan(10);
  });

  it('waits long enough for you to get back to the bike', () => {
    // The recovery sequence - stand, run back, lift, mount - must fit inside
    // the patrol's patience, or the arrest always lands while you are still
    // on the ground and never reads as them waiting you out.
    const longest = CRASH.standTime
      + CRASH.throwMax / CRASH.riderRunSpeed
      + CRASH.liftTime
      + CRASH.mountTime;
    expect(POLICE.arrestPatience).toBeGreaterThan(longest);
  });
});

describe('World: externally driven racers', () => {
  const FLAT_OUT = INPUT({ throttle: 1 });
  const COASTING = INPUT({ throttle: 0, brake: 1 });
  const drive = (r: { id: number }, input = COASTING) => new Map([[r.id, input]]);

  it('drives a named rival from the supplied input instead of the AI', () => {
    const w = new World({ seed: 3 });
    startRace(w);
    const rival = w.rivals[0];
    const before = rival.ai!.planTimer;
    for (let i = 0; i < 60; i++) w.step(DT, FLAT_OUT, drive(rival));
    // Winding the plan timer down is the only thing aiInput does unconditionally,
    // so an untouched timer is proof the AI never thought on this rider's behalf.
    expect(rival.ai!.planTimer).toBe(before);
  });

  it('still runs the AI for racers nobody is riding', () => {
    const w = new World({ seed: 3 });
    startRace(w);
    const [ridden, bot] = w.rivals;
    const botBefore = bot.ai!.planTimer;
    const botStart = bot.s;
    for (let i = 0; i < 60; i++) w.step(DT, FLAT_OUT, drive(ridden));
    // Not `toBeLessThan`: the timer rearms to PLAN_INTERVAL when it runs out,
    // so over a second it can legitimately come back round higher than it
    // started. Any movement at all means aiInput ran.
    expect(bot.ai!.planTimer).not.toBe(botBefore);
    expect(bot.s).toBeGreaterThan(botStart);
  });

  it('actually applies the supplied input to the bike', () => {
    // Same seed twice, so the only difference is who is riding rival zero.
    const botWorld = new World({ seed: 7 });
    const humanWorld = new World({ seed: 7 });
    startRace(botWorld);
    startRace(humanWorld);
    const asBot = botWorld.rivals[0];
    const asHuman = humanWorld.rivals[0];

    for (let i = 0; i < 180; i++) {
      botWorld.step(DT, FLAT_OUT);
      humanWorld.step(DT, FLAT_OUT, drive(asHuman));
    }

    // The bot rides flat out; the human sat on the brakes the whole way.
    expect(asHuman.speed).toBeLessThan(asBot.speed);
    expect(asHuman.s).toBeLessThan(asBot.s);
  });

  it('hands the rider back to the AI the moment the input stops arriving', () => {
    const w = new World({ seed: 3 });
    startRace(w);
    const rival = w.rivals[0];
    for (let i = 0; i < 60; i++) w.step(DT, FLAT_OUT, drive(rival));
    const whileRidden = rival.ai!.planTimer;

    // The peer drops: no map at all, exactly as a disconnect looks.
    for (let i = 0; i < 60; i++) w.step(DT, FLAT_OUT);

    expect(rival.ai!.planTimer).toBeLessThan(whileRidden);
    expect(rival.state).toBe('ride');
  });

  it('ignores an id that is not on the grid', () => {
    const w = new World({ seed: 3 });
    startRace(w);
    const ghost = new Map([[9999, COASTING]]);
    expect(() => {
      for (let i = 0; i < 30; i++) w.step(DT, FLAT_OUT, ghost);
    }).not.toThrow();
    expect(w.state).toBe('racing');
  });

  it('will not let the wire drive the local player', () => {
    const plain = new World({ seed: 9 });
    const spoofed = new World({ seed: 9 });
    startRace(plain);
    startRace(spoofed);

    for (let i = 0; i < 120; i++) {
      plain.step(DT, FLAT_OUT);
      // Someone claims to be riding the local player, and is ignored.
      spoofed.step(DT, FLAT_OUT, drive(spoofed.player));
    }

    expect(spoofed.player.s).toBeCloseTo(plain.player.s, 6);
    expect(spoofed.player.speed).toBeCloseTo(plain.player.speed, 6);
  });

  it('keeps an arresting patrol on its park line rather than on the wire', () => {
    const w = new World({ seed: 11 });
    startRace(w);
    const cop = w.spawnCop();
    cop.s = w.player.s - 6;
    cop.lateral = w.player.lateral + 2;
    knockDown(w.player, 1);

    let guard = 0;
    while (!w.arrestPending && guard++ < 60 * 4) w.step(DT, INPUT({ throttle: 0 }));
    expect(w.arrestPending).toBe(true);

    // Tell the patrol to floor it. The park override runs first, so it parks.
    for (let i = 0; i < 60 && !w.isOver; i++) {
      w.step(DT, INPUT({ throttle: 0 }), drive(cop, FLAT_OUT));
    }
    expect(cop.speed).toBeLessThan(POLICE.parkCreepSpeed + 1);
  });
});

describe('World: the start line belongs to everyone', () => {
  const GAS = INPUT({ throttle: 1 });

  /** Run the lights out, with `remote` driving whoever it names. */
  function launch(w: World, playerInput: RacerInput, remote?: Map<number, RacerInput>) {
    let guard = 0;
    while (w.state === 'countdown' && guard++ < 1000) w.step(DT, playerInput, remote);
  }

  it('gives a remote rider the holeshot for nailing the lights', () => {
    // Before this, only seat 0 could ever launch well - every remote rider
    // was stuck watching the local player get a boost they could not earn.
    const w = new World({ seed: 21 });
    const rival = w.rivals[0];
    launch(w, INPUT(), new Map([[rival.id, GAS]]));
    expect(rival.boostTimer).toBeGreaterThan(0);
  });

  it('denies it to a remote rider who is not on the gas at the lights', () => {
    const w = new World({ seed: 21 });
    const rival = w.rivals[0];
    launch(w, INPUT(), new Map([[rival.id, INPUT({ throttle: 0 })]]));
    expect(rival.boostTimer).toBe(0);
  });

  it('stays armed once the gas is touched inside the window', () => {
    // Quirk of the existing rule, recorded rather than changed: arming is
    // sticky, so letting go after touching the gas inside the last 0.55s
    // still launches. Remote riders now behave exactly as the local player
    // always has, which is the point of this change.
    const w = new World({ seed: 21 });
    const rival = w.rivals[0];
    let guard = 0;
    while (w.state === 'countdown' && guard++ < 1000) {
      const onGas = w.countdown > 0.3;
      w.step(DT, INPUT(), new Map([[rival.id, INPUT({ throttle: onGas ? 1 : 0 })]]));
    }
    expect(rival.boostTimer).toBeGreaterThan(0);

    // ...and the local player does the same thing, given the same input.
    const local = new World({ seed: 21 });
    let g2 = 0;
    while (local.state === 'countdown' && g2++ < 1000) {
      local.step(DT, INPUT({ throttle: local.countdown > 0.3 ? 1 : 0 }));
    }
    expect(local.player.boostTimer).toBeGreaterThan(0);
  });

  it('never gives it to a rider the AI is driving', () => {
    const w = new World({ seed: 21 });
    launch(w, GAS);
    for (const r of w.rivals) expect(r.boostTimer).toBe(0);
  });

  it('still gives it to the local player', () => {
    const w = new World({ seed: 21 });
    const events = startRace(w, GAS);
    expect(w.player.boostTimer).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'holeshot')).toBe(true);
  });

  it('reports the holeshot event only for the local player', () => {
    const w = new World({ seed: 21 });
    const rival = w.rivals[0];
    const events: SimEvent[] = [];
    let guard = 0;
    while (w.state === 'countdown' && guard++ < 1000) {
      events.push(...w.step(DT, INPUT(), new Map([[rival.id, GAS]])));
    }
    // The rival got the boost; the cue on screen is the player's alone.
    expect(rival.boostTimer).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'holeshot')).toBe(false);
  });
});

describe('World: telling riders apart', () => {
  it('gives every rider on the grid a different colour', () => {
    // Two bikes in the same colour is the one thing that makes a pack
    // unreadable at speed.
    for (const seed of [1, 7, 42, 999]) {
      const w = new World({ seed });
      const colours = new Set(w.racers.map((r) => r.color));
      expect(colours.size, `seed ${seed}`).toBe(w.racers.length);
    }
  });

  it('deals a different grid each race', () => {
    const a = new World({ seed: 1 }).racers.map((r) => r.color);
    const b = new World({ seed: 2 }).racers.map((r) => r.color);
    expect(a).not.toEqual(b);
  });

  it('deals the identical grid to everyone on the same seed', () => {
    // Every browser in a room rebuilds the field from the room's seed. If the
    // shuffle used Math.random the same rider would wear different colours on
    // different screens.
    const a = new World({ seed: 4242 }).racers.map((r) => r.color);
    const b = new World({ seed: 4242 }).racers.map((r) => r.color);
    expect(a).toEqual(b);
  });

  it('starts with the camera on the local rider', () => {
    const w = new World({ seed: 3 });
    expect(w.localRacer).toBe(w.player);
  });
});

describe('World: nobody shares a name', () => {
  it('gives every rider on the grid a distinct name', () => {
    // The grid is drawn with names now, and two riders called the same thing
    // is as unreadable as two in the same colour.
    for (const seed of [1, 9, 77]) {
      const w = new World({ seed, riderName: 'ACE' });
      const names = w.racers.map((r) => r.name);
      expect(new Set(names).size, `seed ${seed}`).toBe(names.length);
    }
  });

  it('puts the local rider name on racer zero when playing offline', () => {
    // Offline there is no seating, so racer 0 is you.
    expect(new World({ seed: 2, riderName: 'ACE' }).player.name).toBe('ACE');
  });
});

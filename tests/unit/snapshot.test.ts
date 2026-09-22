import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/world';
import {
  SnapshotBuffer, applyCars, applyPickups, applyRacers, captureCars, capturePeds,
  capturePickups, captureRacers, lerpCars, lerpRacers, reconcileLocalRacer,
} from '../../src/net/snapshot';
import { decode } from '../../src/net/protocol';
import type { CarSnapshot, RacerSnapshot, StateMessage } from '../../src/net/protocol';

const car = (id: number, over: Partial<CarSnapshot> = {}): CarSnapshot => ({
  id, s: 0, lateral: 0, speed: 20, dir: 1, brake: 0, swerve: 0.2,
  color: 0xffffff, type: 'sedan', active: true, ...over,
});

const racer = (id: number, over: Partial<RacerSnapshot> = {}): RacerSnapshot => ({
  id, s: 0, lateral: 0, speed: 0, lean: 0, health: 100, hop: 0,
  state: 'ride', riderPhase: 'standing', attackDir: 0, attackTimer: 0, place: 1,
  finishTime: null, ...over,
});

const frame = (seq: number, time: number, racers: RacerSnapshot[], cars: CarSnapshot[] = []): StateMessage =>
  ({ t: 'state', seq, time, phase: 'racing', countdown: 0, racers, cars, peds: [], cops: [], taken: [] });

describe('capturing the grid', () => {
  it('photographs every rider', () => {
    const w = new World({ seed: 4 });
    const shot = captureRacers(w.racers);
    expect(shot).toHaveLength(w.racers.length);
    expect(shot.map((r) => r.id)).toEqual(w.racers.map((r) => r.id));
  });

  it('rounds off detail nobody can see', () => {
    const w = new World({ seed: 4 });
    w.player.s = 123.456789;
    expect(captureRacers([w.player])[0].s).toBe(123.46);
  });
});

describe('applying a snapshot', () => {
  it('moves the rider it names', () => {
    const w = new World({ seed: 4 });
    applyRacers(w.racers, [racer(w.rivals[0].id, { s: 500, speed: 42 })]);
    expect(w.rivals[0].s).toBe(500);
    expect(w.rivals[0].speed).toBe(42);
  });

  it('leaves riders the snapshot says nothing about alone', () => {
    const w = new World({ seed: 4 });
    const before = w.rivals[1].s;
    applyRacers(w.racers, [racer(w.rivals[0].id, { s: 500 })]);
    expect(w.rivals[1].s).toBe(before);
  });

  it('ignores an id that is not on this grid', () => {
    const w = new World({ seed: 4 });
    expect(() => applyRacers(w.racers, [racer(9999, { s: 500 })])).not.toThrow();
  });

  it('does not disturb the AI state of a rider it moves', () => {
    // A guest draws the grid; it does not get to think for anyone on it.
    const w = new World({ seed: 4 });
    const ai = w.rivals[0].ai;
    applyRacers(w.racers, [racer(w.rivals[0].id, { s: 500 })]);
    expect(w.rivals[0].ai).toBe(ai);
  });
});

describe('blending two frames', () => {
  const a = [racer(1, { s: 0, lateral: -2, state: 'ride' })];
  const b = [racer(1, { s: 100, lateral: 2, state: 'down' })];

  it('sits halfway at the midpoint', () => {
    expect(lerpRacers(a, b, 0.5)[0]).toMatchObject({ s: 50, lateral: 0 });
  });

  it('clamps outside the span rather than extrapolating', () => {
    expect(lerpRacers(a, b, -1)[0].s).toBe(0);
    expect(lerpRacers(a, b, 5)[0].s).toBe(100);
  });

  it('holds discrete state until the frame is reached', () => {
    // Showing a rider on the floor while the bike is still upright looks worse
    // than showing the crash a few milliseconds late.
    expect(lerpRacers(a, b, 0.9)[0].state).toBe('ride');
  });

  it('keeps a rider the newer frame has dropped', () => {
    expect(lerpRacers(a, [], 0.5)[0].s).toBe(0);
  });
});

describe('the snapshot buffer', () => {
  it('reports nothing before anything arrives', () => {
    expect(new SnapshotBuffer().sample(0)).toBeNull();
  });

  it('hands back the only frame it has', () => {
    const b = new SnapshotBuffer();
    b.push(frame(1, 10, [racer(1, { s: 5 })]), 1000);
    expect(b.sample(1000)?.racers[0].s).toBe(5);
  });

  it('drops a frame that arrives out of order', () => {
    const b = new SnapshotBuffer();
    b.push(frame(2, 10, [racer(1, { s: 20 })]), 1000);
    b.push(frame(1, 9, [racer(1, { s: 10 })]), 1001); // overtaken in flight
    expect(b.size).toBe(1);
  });

  it('drops a duplicate', () => {
    const b = new SnapshotBuffer();
    b.push(frame(1, 10, [racer(1)]), 1000);
    b.push(frame(1, 10, [racer(1)]), 1001);
    expect(b.size).toBe(1);
  });

  it('interpolates between the two frames the render time falls between', () => {
    const b = new SnapshotBuffer(0.1);
    // Two frames a tenth of a second apart, arriving in real time.
    b.push(frame(1, 10.0, [racer(1, { s: 0 })]), 1000);
    b.push(frame(2, 10.1, [racer(1, { s: 100 })]), 1100);
    // At local 1150 the host clock reads 10.15; drawing 0.1s back gives 10.05,
    // which is halfway between the two frames.
    expect(b.sample(1150)?.racers[0].s).toBeCloseTo(50, 5);
  });

  it('holds the newest frame when the host stops sending', () => {
    const b = new SnapshotBuffer(0.1);
    b.push(frame(1, 10.0, [racer(1, { s: 0 })]), 1000);
    b.push(frame(2, 10.1, [racer(1, { s: 100 })]), 1100);
    // Long silence: hold position rather than inventing motion off the end.
    expect(b.sample(9000)?.racers[0].s).toBe(100);
  });

  it('holds the oldest frame when asked for a time before it', () => {
    const b = new SnapshotBuffer(5);
    b.push(frame(1, 10.0, [racer(1, { s: 7 })]), 1000);
    b.push(frame(2, 10.1, [racer(1, { s: 100 })]), 1100);
    expect(b.sample(1100)?.racers[0].s).toBe(7);
  });

  it('forgets frames it will never draw again', () => {
    const b = new SnapshotBuffer(0.1, 4);
    for (let i = 1; i <= 20; i++) b.push(frame(i, i * 0.05, [racer(1)]), 1000 + i * 50);
    expect(b.size).toBe(4);
  });

  it('estimates the host clock from how long ago the frame landed', () => {
    const b = new SnapshotBuffer();
    b.push(frame(1, 10.0, [racer(1)]), 1000);
    expect(b.hostTime(1250)).toBeCloseTo(10.25, 5);
  });
});

describe('traffic over the wire', () => {
  it('photographs the whole pool', () => {
    const w = new World({ seed: 4 });
    const shot = captureCars(w.traffic.cars);
    expect(shot).toHaveLength(w.traffic.cars.length);
    expect(shot[0].type).toBe(w.traffic.cars[0].type.key);
  });

  it('stays small enough to send every frame', () => {
    // The pool is about a dozen cars by design - sparse traffic is the point -
    // so the whole lot costs less than the riders do.
    const w = new World({ seed: 4 });
    expect(JSON.stringify(captureCars(w.traffic.cars)).length).toBeLessThan(2048);
  });

  it('moves a car the snapshot names', () => {
    const w = new World({ seed: 4 });
    const target = w.traffic.cars[0];
    applyCars(w.traffic.cars, [car(target.id, { s: 900, lateral: 2 })]);
    expect(target.s).toBe(900);
    expect(target.lateral).toBe(2);
  });

  it('restores the car type from its key', () => {
    const w = new World({ seed: 4 });
    const target = w.traffic.cars[0];
    applyCars(w.traffic.cars, [car(target.id, { type: 'truck' })]);
    expect(target.type.key).toBe('truck');
  });

  it('keeps the existing type if the key is unknown', () => {
    const w = new World({ seed: 4 });
    const target = w.traffic.cars[0];
    const before = target.type;
    applyCars(w.traffic.cars, [car(target.id, { type: 'spaceship' })]);
    expect(target.type).toBe(before);
  });

  it('interpolates a car that is just driving along', () => {
    expect(lerpCars([car(1, { s: 0 })], [car(1, { s: 20 })], 0.5)[0].s).toBe(10);
  });

  it('snaps a recycled car instead of flying it back down the road', () => {
    // The pool recycles: a car that passed you reappears hundreds of metres
    // ahead. Interpolating that sends it backwards through the whole field.
    const out = lerpCars([car(1, { s: 100 })], [car(1, { s: 900 })], 0.5);
    expect(out[0].s).toBe(900);
  });

  it('snaps when the car changed type, which means it recycled', () => {
    const out = lerpCars([car(1, { s: 100, type: 'sedan' })], [car(1, { s: 110, type: 'bus' })], 0.5);
    expect(out[0].type).toBe('bus');
    expect(out[0].s).toBe(110);
  });

  it('carries traffic through the interpolation buffer', () => {
    const b = new SnapshotBuffer(0.1);
    b.push(frame(1, 10.0, [racer(1)], [car(9, { s: 0 })]), 1000);
    b.push(frame(2, 10.1, [racer(1)], [car(9, { s: 20 })]), 1100);
    expect(b.sample(1150)?.cars[0].s).toBeCloseTo(10, 5);
  });
});

describe('riding our own bike and correcting it', () => {
  it('leaves our own rider out when asked, so prediction survives a frame', () => {
    // The bug this exists for: a guest was overwritten with the host's copy
    // of itself sixty times a second, so a button press could not move the
    // bike - only ask for it to be moved, a round trip ago.
    const w = new World({ seed: 4 });
    w.localRacer = w.player;
    w.player.s = 120;
    applyRacers(w.racers, [racer(w.player.id, { s: 500 }), racer(w.rivals[0].id, { s: 700 })], w.player.id);
    expect(w.player.s).toBe(120);
    expect(w.rivals[0].s).toBe(700);
  });

  it('closes a small disagreement gradually rather than snatching the bike', () => {
    const w = new World({ seed: 4 });
    w.player.s = 100;
    reconcileLocalRacer(w.player, racer(w.player.id, { s: 102, state: 'ride' }), 1 / 60);
    expect(w.player.s).toBeGreaterThan(100);
    expect(w.player.s).toBeLessThan(101);
  });

  it('converges on the host over a handful of frames', () => {
    const w = new World({ seed: 4 });
    w.player.s = 100;
    for (let i = 0; i < 60; i++) {
      reconcileLocalRacer(w.player, racer(w.player.id, { s: 103, state: 'ride' }), 1 / 60);
    }
    expect(w.player.s).toBeCloseTo(103, 1);
  });

  it('corrects at the same rate whatever the frame rate', () => {
    const slow = new World({ seed: 4 });
    const fast = new World({ seed: 4 });
    slow.player.s = 100;
    fast.player.s = 100;
    // A tenth of a second, taken in three steps or in twelve.
    for (let i = 0; i < 3; i++) reconcileLocalRacer(slow.player, racer(slow.player.id, { s: 104 }), 1 / 30);
    for (let i = 0; i < 12; i++) reconcileLocalRacer(fast.player, racer(fast.player.id, { s: 104 }), 1 / 120);
    expect(fast.player.s).toBeCloseTo(slow.player.s, 2);
  });

  it('snaps when the disagreement is too big to be lag', () => {
    const w = new World({ seed: 4 });
    w.player.s = 100;
    reconcileLocalRacer(w.player, racer(w.player.id, { s: 400, speed: 30 }), 1 / 60);
    expect(w.player.s).toBe(400);
    expect(w.player.speed).toBe(30);
  });

  it('takes the host\'s word on damage, which is not ours to predict', () => {
    const w = new World({ seed: 4 });
    w.player.health = 100;
    reconcileLocalRacer(w.player, racer(w.player.id, { health: 40 }), 1 / 60);
    expect(w.player.health).toBe(40);
  });

  it('puts us on the floor where the host says, not where we guessed', () => {
    const w = new World({ seed: 4 });
    w.player.s = 100;
    reconcileLocalRacer(w.player, racer(w.player.id, { s: 101, state: 'down', riderPhase: 'tumble' }), 1 / 60);
    expect(w.player.state).toBe('down');
    expect(w.player.s).toBe(101);
  });

  it('snaps back onto the bike where the host says we remounted', () => {
    const w = new World({ seed: 4 });
    w.player.state = 'down';
    w.player.s = 100;
    reconcileLocalRacer(w.player, racer(w.player.id, { s: 140, state: 'ride' }), 1 / 60);
    expect(w.player.s).toBe(140);
  });
});

describe('how far behind the host to draw', () => {
  it('starts at the floor, which is what a clean link deserves', () => {
    const b = new SnapshotBuffer(0.1);
    expect(b.delay).toBe(0.1);
  });

  it('says how stale the newest frame is', () => {
    const b = new SnapshotBuffer();
    expect(b.ageMs(1000)).toBe(Infinity);
    b.push(frame(1, 0, [racer(0)]), 1000);
    expect(b.ageMs(1050)).toBe(50);
  });

  it('stays at the floor while frames arrive on time', () => {
    const b = new SnapshotBuffer(0.1);
    for (let i = 0; i < 40; i++) b.push(frame(i, i * 0.05, [racer(0)]), i * 50);
    expect(b.delay).toBeCloseTo(0.1, 2);
  });

  it('gives itself more room when frames arrive in bursts', () => {
    // The Dhaka case: the average is fine, the spacing is not, and a buffer
    // sized for the average runs dry every time a frame is late.
    const b = new SnapshotBuffer(0.1);
    let at = 0;
    for (let i = 0; i < 40; i++) {
      at += i % 2 === 0 ? 10 : 180; // same average, wildly uneven
      b.push(frame(i, i * 0.05, [racer(0)]), at);
    }
    expect(b.delay).toBeGreaterThan(0.12);
  });

  it('never buries the controls under more than its ceiling', () => {
    const b = new SnapshotBuffer(0.1, 12, 0.35);
    let at = 0;
    for (let i = 0; i < 60; i++) {
      at += i % 2 === 0 ? 5 : 2000; // catastrophic
      b.push(frame(i, i * 0.05, [racer(0)]), at);
    }
    expect(b.delay).toBeLessThanOrEqual(0.35);
  });

  it('comes back down once the link settles', () => {
    const b = new SnapshotBuffer(0.1);
    let at = 0;
    for (let i = 0; i < 20; i++) {
      at += i % 2 === 0 ? 10 : 180;
      b.push(frame(i, i * 0.05, [racer(0)]), at);
    }
    const rough = b.delay;
    for (let i = 20; i < 400; i++) {
      at += 50;
      b.push(frame(i, i * 0.05, [racer(0)]), at);
    }
    expect(b.delay).toBeLessThan(rough);
  });
});


describe('seeing the punches', () => {
  it('carries a swing to the guest, so a fight is visible rather than inferred', () => {
    // Without this a guest saw no punches at all: health dropped, riders fell
    // over, and nothing on screen explained why.
    const w = new World({ seed: 4 });
    w.rivals[0].attackTimer = 0.3;
    w.rivals[0].attackDir = 1;
    const shot = captureRacers([w.rivals[0]])[0];
    expect(shot.attackTimer).toBeCloseTo(0.3, 2);

    const other = new World({ seed: 4 });
    applyRacers(other.racers, [shot]);
    const mirrored = other.racers.find((r) => r.id === w.rivals[0].id)!;
    expect(mirrored.attackTimer).toBeCloseTo(0.3, 2);
  });

  it('runs a swing down smoothly between frames', () => {
    const blended = lerpRacers(
      [racer(1, { attackTimer: 0.4 })],
      [racer(1, { attackTimer: 0.2 })],
      0.5,
    );
    expect(blended[0]!.attackTimer).toBeCloseTo(0.3, 5);
  });

  it('does not start a swing early', () => {
    // A swing that appears in the newer frame has not started yet at the
    // point we are drawing, and showing an arm out before the punch reads as
    // a rider flailing at nothing.
    const blended = lerpRacers(
      [racer(1, { attackTimer: 0 })],
      [racer(1, { attackTimer: 0.45 })],
      0.5,
    );
    expect(blended[0]!.attackTimer).toBe(0);
  });

  it('leaves our own swing alone, because we threw it ourselves', () => {
    const w = new World({ seed: 4 });
    w.player.attackTimer = 0.35;
    reconcileLocalRacer(w.player, racer(w.player.id, { attackTimer: 0, state: 'ride' }), 1 / 60);
    expect(w.player.attackTimer).toBe(0.35);
  });
});

describe('finishing times travel with the grid', () => {
  it('photographs them off the host', () => {
    const w = new World({ seed: 4 });
    w.racers[1].finishTime = 77.777;
    const shot = captureRacers(w.racers);
    expect(shot[0].finishTime).toBeNull();
    // Rounded like everything else: nobody reads the fourth decimal.
    expect(shot[1].finishTime).toBeCloseTo(77.78, 2);
  });

  it('writes them onto a guest, so the board can show a time at all', () => {
    const w = new World({ seed: 4 });
    applyRacers(w.racers, [racer(1, { state: 'finished', finishTime: 104.5 })]);
    expect(w.racers[1].finishTime).toBe(104.5);
    expect(w.racers[1].state).toBe('finished');
  });

  it('gives our own rider the host’s time rather than our guess at it', () => {
    const w = new World({ seed: 4 });
    const me = w.localRacer;
    me.finishTime = 99;
    reconcileLocalRacer(me, racer(me.id, { state: 'finished', finishTime: 101.25 }), 1 / 60);
    expect(me.finishTime).toBe(101.25);
  });

  it('does not invent one while interpolating', () => {
    const blended = lerpRacers(
      [racer(1, { finishTime: null })],
      [racer(1, { finishTime: 50 })],
      0.5,
    );
    // A time appears when the rider crosses the line, not half way there.
    expect(blended[0].finishTime).toBeNull();
  });
});

describe('a buffer between two races', () => {
  it('forgets frames about the race that just ended', () => {
    const buffer = new SnapshotBuffer(0.1);
    buffer.push(frame(1, 106, [racer(0)]), 1000);
    expect(buffer.size).toBe(1);

    buffer.clear();

    // Nothing held, and nothing to draw until the new race starts talking.
    expect(buffer.size).toBe(0);
    expect(buffer.sample(1000)).toBeNull();
    expect(buffer.ageMs(1000)).toBe(Infinity);
  });

  it('still refuses a frame it has already seen', () => {
    // The sequence belongs to the link, not to the race: forgetting it would
    // let a frame that really is stale walk back in as if it were new.
    const buffer = new SnapshotBuffer(0.1);
    buffer.push(frame(7, 106, [racer(0, { s: 4628 })]), 1000);
    buffer.clear();
    buffer.push(frame(7, 106, [racer(0, { s: 4628 })]), 1010);
    expect(buffer.size).toBe(0);

    buffer.push(frame(8, 0.1, [racer(0, { s: 3 })]), 1020);
    expect(buffer.sample(1020)!.racers[0].s).toBe(3);
  });
});

describe('the crowd is sent to everybody who is riding', () => {
  const crowd = (positions: number[]) => positions.map((s, i) => ({
    id: i, s, lateral: 14, height: 1.8, state: 'walking' as const,
  })) as unknown as Parameters<typeof capturePeds>[0];

  it('sends a guest the people in front of them, not the host', () => {
    // The fairness hole: culling around one point meant a guest a kilometre up
    // the road got no pedestrian frames at all, so the people they were about
    // to ride into were whatever their own machine had worked out.
    const peds = crowd([100, 1200]);
    const hostOnly = capturePeds(peds, [100]);
    expect(hostOnly.map((p) => p[0])).toEqual([0]);

    const both = capturePeds(peds, [100, 1200]);
    expect(both.map((p) => p[0])).toEqual([0, 1]);
  });

  it('sends each pedestrian once, however many riders can see them', () => {
    // Two riders together must not double the frame.
    const peds = crowd([500]);
    const shot = capturePeds(peds, [480, 500, 520]);
    expect(shot).toHaveLength(1);
  });

  it('still leaves out the ones nobody is near', () => {
    const peds = crowd([100, 5000]);
    expect(capturePeds(peds, [100]).map((p) => p[0])).toEqual([0]);
  });

  it('sends nothing when there is nobody to send it to', () => {
    expect(capturePeds(crowd([100]), [])).toEqual([]);
  });
});

describe('the host decides which cars exist', () => {
  it('takes a car off the road when the host says it is gone', () => {
    // The disappearing-car bug ran the other way: the guest's own pool
    // recycled a car the host still had, and the renderer - which skips
    // inactive cars - stopped drawing one that was really there.
    const w = new World({ seed: 4 });
    const target = w.traffic.cars[0];
    target.active = true;
    applyCars(w.traffic.cars, [car(target.id, { active: false })]);
    expect(target.active).toBe(false);
  });

  it('puts one back when the host says it is there', () => {
    const w = new World({ seed: 4 });
    const target = w.traffic.cars[0];
    target.active = false;
    applyCars(w.traffic.cars, [car(target.id, { active: true, s: 42 })]);
    expect(target.active).toBe(true);
    expect(target.s).toBe(42);
  });

  it('assumes a car is there when an older frame does not say', () => {
    const raw = { id: 1, s: 0, lateral: 0, speed: 20, dir: 1, brake: 0, swerve: 0, color: 0, type: 'sedan' };
    const back = decode(JSON.stringify({
      t: 'state', seq: 1, time: 0, phase: 'racing', countdown: 0,
      racers: [], cops: [], peds: [], cars: [raw],
    })) as StateMessage;
    expect(back.cars[0].active).toBe(true);
  });
});

describe('what is left lying in the road', () => {
  it('tells a guest which pickups are gone', () => {
    // Never on the wire at all before this, so every browser kept its own idea
    // of what was still there: two riders could take the same health box, and
    // one the host had consumed went on glowing on everybody else's screen.
    const w = new World({ seed: 6 });
    const [a, b] = w.pickups;
    expect(a.taken).toBe(false);
    applyPickups(w.pickups, [a.id]);
    expect(a.taken).toBe(true);
    expect(b.taken).toBe(false);
  });

  it('photographs only the ones that are gone', () => {
    const w = new World({ seed: 6 });
    expect(capturePickups(w.pickups)).toEqual([]);
    w.pickups[2].taken = true;
    w.pickups[5].taken = true;
    expect(capturePickups(w.pickups)).toEqual([w.pickups[2].id, w.pickups[5].id]);
  });

  it('never puts one back', () => {
    // A pickup does not reappear, so an id missing from a frame means nobody
    // has touched it yet - not that it has returned.
    const w = new World({ seed: 6 });
    w.pickups[0].taken = true;
    applyPickups(w.pickups, []);
    expect(w.pickups[0].taken).toBe(true);
  });
});

describe('a guest on a slow link is still smooth', () => {
  /** 100ms each way: the host's copy of us is a round trip behind. */
  const RTT = 0.2;
  const SPEED = 65;

  it('does not drag a self-ridden bike backwards at 200ms', () => {
    // The bug this exists for: the host's copy of our own bike is our own
    // position as it was a round trip ago - thirteen metres back at racing
    // speed. Judged by the tolerance that suits a predicted bike, that snapped
    // the rider backwards every single frame, and the better the rider's
    // connection got the less it happened. Exactly backwards.
    const w = new World({ seed: 71 });
    const me = w.localRacer;
    me.state = 'ride';
    me.speed = SPEED;
    me.s = 1000;

    let snapped = 0;
    for (let i = 0; i < 120; i++) {
      me.s += SPEED / 60;
      // What the host knows about us: where we were a round trip ago.
      const echo = racer(me.id, { s: me.s - SPEED * RTT, speed: SPEED, state: 'ride' });
      const before = me.s;
      reconcileLocalRacer(me, echo, 1 / 60, { owned: true });
      if (me.s < before) snapped++;
    }
    expect(snapped).toBe(0);
  });

  it('still catches a real disagreement', () => {
    // Far enough that no latency explains it: the host refused our claims and
    // put us somewhere else entirely.
    const w = new World({ seed: 71 });
    const me = w.localRacer;
    me.state = 'ride';
    me.speed = SPEED;
    me.s = 1000;
    reconcileLocalRacer(me, racer(me.id, { s: 1300, speed: SPEED, state: 'ride' }), 1 / 60, {
      owned: true,
    });
    expect(me.s).toBe(1300);
  });

  it('is stricter about a bike we are only predicting', () => {
    // Somebody else's rider has no claim of ours behind it, so the host's word
    // is the only word and it is taken quickly.
    const w = new World({ seed: 71 });
    const them = w.rivals[0];
    them.state = 'ride';
    them.speed = SPEED;
    them.s = 1000;
    reconcileLocalRacer(them, racer(them.id, { s: 1010, speed: SPEED, state: 'ride' }), 1 / 60);
    expect(them.s).toBe(1010);
  });

  it('holds our own crossing until the host has heard about it', () => {
    // We cross the line a round trip before the host can possibly say so, and
    // every frame in that gap still has us riding. Taking them un-finished us
    // and threw the bike back behind the flag, again and again, at the one
    // moment of a race nobody wants to see stutter.
    const w = new World({ seed: 71 });
    const me = w.localRacer;
    me.state = 'finished';
    me.finishTime = 90;
    me.speed = SPEED;
    me.s = 1000;

    for (let i = 0; i < 12; i++) {
      reconcileLocalRacer(me, racer(me.id, {
        s: me.s - SPEED * RTT, speed: SPEED, state: 'ride', finishTime: null,
      }), 1 / 60, { owned: true });
    }
    expect(me.state).toBe('finished');
    expect(me.finishTime).toBe(90);
    expect(me.s).toBe(1000);
  });

  it('takes the host\'s word once it arrives', () => {
    const w = new World({ seed: 71 });
    const me = w.localRacer;
    me.state = 'finished';
    me.finishTime = 90;
    me.speed = SPEED;
    me.s = 1000;
    // The host's clock is the one the board is printed from, not our guess.
    reconcileLocalRacer(me, racer(me.id, {
      s: 998, speed: 0, state: 'finished', finishTime: 90.4,
    }), 1 / 60, { owned: true });
    expect(me.finishTime).toBe(90.4);
    expect(me.s).toBe(998);
  });

  it('gives a predicted crossing up on a real disagreement', () => {
    // We think we are home; the host has us three hundred metres short. That
    // is not latency, and holding onto it would be holding onto a race that
    // never ends.
    const w = new World({ seed: 71 });
    const me = w.localRacer;
    me.state = 'finished';
    me.finishTime = 90;
    me.speed = SPEED;
    me.s = 1000;
    reconcileLocalRacer(me, racer(me.id, {
      s: 700, speed: SPEED, state: 'ride', finishTime: null,
    }), 1 / 60, { owned: true });
    expect(me.state).toBe('ride');
    expect(me.finishTime).toBeNull();
    expect(me.s).toBe(700);
  });
});

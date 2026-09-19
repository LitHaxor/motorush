import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/world';
import {
  SnapshotBuffer, applyCars, applyRacers, captureCars, captureRacers, lerpCars, lerpRacers,
} from '../../src/net/snapshot';
import type { CarSnapshot, RacerSnapshot, StateMessage } from '../../src/net/protocol';

const car = (id: number, over: Partial<CarSnapshot> = {}): CarSnapshot => ({
  id, s: 0, lateral: 0, speed: 20, dir: 1, brake: 0, swerve: 0.2,
  color: 0xffffff, type: 'sedan', ...over,
});

const racer = (id: number, over: Partial<RacerSnapshot> = {}): RacerSnapshot => ({
  id, s: 0, lateral: 0, speed: 0, lean: 0, health: 100, hop: 0,
  state: 'ride', riderPhase: 'standing', attackDir: 0, place: 1, ...over,
});

const frame = (seq: number, time: number, racers: RacerSnapshot[], cars: CarSnapshot[] = []): StateMessage =>
  ({ t: 'state', seq, time, race: 'racing', countdown: 0, racers, cars, peds: [], cops: [] });

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

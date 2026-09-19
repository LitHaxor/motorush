import { describe, it, expect } from 'vitest';
import { decode, encode, type StateMessage } from '../../src/net/protocol';

const STATE: StateMessage = {
  t: 'state',
  seq: 7,
  time: 12.5,
  race: 'racing',
  countdown: 0,
  racers: [{
    id: 3, s: 100, lateral: -1.5, speed: 40, lean: 0.2, health: 80, hop: 0,
    state: 'ride', riderPhase: 'standing', attackDir: 1, place: 2,
  }],
  cars: [{
    id: 5, s: 300, lateral: 1.2, speed: 22, dir: 1, brake: 0, swerve: 0.2,
    color: 0xff0000, type: 'sedan',
  }],
  peds: [[9, 120, 14.2, 0, 0]],
};

describe('round trip', () => {
  it('survives encode/decode unchanged', () => {
    expect(decode(encode(STATE))).toEqual(STATE);
  });

  it('carries an input frame', () => {
    const msg = {
      t: 'input' as const,
      seq: 1,
      input: { throttle: 1, brake: 0, steer: -0.5, attackLeft: true, attackRight: false },
    };
    expect(decode(encode(msg))).toEqual(msg);
  });
});

describe('refusing rubbish off the wire', () => {
  it('drops malformed JSON', () => {
    expect(decode('not json')).toBeNull();
    expect(decode('')).toBeNull();
  });

  it('drops a frame with no known type', () => {
    expect(decode('{"t":"nonsense"}')).toBeNull();
    expect(decode('null')).toBeNull();
    expect(decode('[1,2,3]')).toBeNull();
  });

  it('drops a state frame with no racer list', () => {
    expect(decode('{"t":"state","seq":1}')).toBeNull();
  });

  it('treats a frame with no traffic as empty roads, not a bad frame', () => {
    const out = decode('{"t":"state","seq":1,"racers":[]}');
    expect(out).not.toBeNull();
    expect((out as StateMessage).cars).toEqual([]);
    expect((out as StateMessage).peds).toEqual([]);
  });

  it('drops a malformed pedestrian tuple rather than the whole frame', () => {
    const out = decode('{"t":"state","seq":1,"racers":[],"peds":[[1,2],[3,4,5,6,1]]}') as StateMessage;
    expect(out.peds).toHaveLength(1);
    expect(out.peds[0][0]).toBe(3);
  });

  it('clamps an out-of-range pedestrian state', () => {
    // A bad index would otherwise index past PED_STATES and hand the renderer
    // undefined.
    const out = decode('{"t":"state","seq":1,"racers":[],"peds":[[1,2,3,0,99]]}') as StateMessage;
    expect(out.peds[0][4]).toBeLessThan(6);
    expect(out.peds[0][4]).toBeGreaterThanOrEqual(0);
  });

  it('discards cars with no id', () => {
    const out = decode('{"t":"state","seq":1,"racers":[],"cars":[{"s":1},{"id":2}]}') as StateMessage;
    expect(out.cars.map((c) => c.id)).toEqual([2]);
  });

  it('forces a car direction to one of the two legal values', () => {
    const out = decode('{"t":"state","seq":1,"racers":[],"cars":[{"id":1,"dir":77}]}') as StateMessage;
    expect(out.cars[0].dir).toBe(1);
  });

  it('discards racers with no id, which match nothing on the grid', () => {
    const out = decode('{"t":"state","seq":1,"racers":[{"s":1},{"id":2,"s":5}]}');
    expect(out?.t).toBe('state');
    expect((out as StateMessage).racers.map((r) => r.id)).toEqual([2]);
  });

  it('replaces non-finite numbers rather than passing NaN into the sim', () => {
    const out = decode(JSON.stringify({
      t: 'state', seq: 1, racers: [{ id: 1, s: 'x', speed: null, lean: {} }],
    })) as StateMessage;
    expect(out.racers[0].s).toBe(0);
    expect(out.racers[0].speed).toBe(0);
    expect(Number.isFinite(out.racers[0].lean)).toBe(true);
  });

  it('falls back to a known value for an unrecognised state', () => {
    const out = decode(JSON.stringify({
      t: 'state', seq: 1, racers: [{ id: 1, state: 'exploded', riderPhase: 'moonwalk' }],
    })) as StateMessage;
    expect(out.racers[0].state).toBe('ride');
    expect(out.racers[0].riderPhase).toBe('standing');
  });
});

describe('inputs are clamped, not merely parsed', () => {
  it('caps a throttle from a peer that wants to cheat', () => {
    // The sim trusts these to be in range; 1e9 would otherwise be free speed.
    const out = decode(JSON.stringify({
      t: 'input', seq: 1, input: { throttle: 1e9, brake: -5, steer: 42 },
    }));
    expect(out).toMatchObject({
      input: { throttle: 1, brake: 0, steer: 1 },
    });
  });

  it('clamps steering at both ends', () => {
    const out = decode(JSON.stringify({ t: 'input', seq: 1, input: { steer: -42 } }));
    expect(out).toMatchObject({ input: { steer: -1 } });
  });

  it('treats a missing input object as neutral', () => {
    expect(decode('{"t":"input","seq":1}')).toMatchObject({
      input: { throttle: 0, brake: 0, steer: 0, attackLeft: false, attackRight: false },
    });
  });

  it('only accepts a real boolean for an attack', () => {
    const out = decode(JSON.stringify({
      t: 'input', seq: 1, input: { attackLeft: 'yes', attackRight: 1 },
    }));
    expect(out).toMatchObject({ input: { attackLeft: false, attackRight: false } });
  });
});

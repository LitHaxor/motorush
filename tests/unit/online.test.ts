import { describe, it, expect } from 'vitest';
import { RemoteInputTracker, Ticker } from '../../src/net/online';
import { makeRoomCode, normaliseRoomCode } from '../../src/net/lobby';
import type { RacerInput } from '../../src/sim/types';

const INPUT = (over: Partial<RacerInput> = {}): RacerInput => ({
  throttle: 1, brake: 0, steer: 0, attackLeft: false, attackRight: false, ...over,
});

describe('who is riding which bike', () => {
  it('keys inputs by seat, which is the racer id', () => {
    const t = new RemoteInputTracker();
    t.set(3, INPUT({ steer: 0.5 }), 1000);
    expect(t.current(1000).get(3)).toMatchObject({ steer: 0.5 });
  });

  it('hands back exactly what World.step expects', () => {
    const t = new RemoteInputTracker();
    t.set(1, INPUT(), 1000);
    t.set(2, INPUT(), 1000);
    const map = t.current(1000);
    expect([...map.keys()].sort()).toEqual([1, 2]);
  });

  it('gives the bike back to the AI when a rider goes quiet', () => {
    // A link can stay open while nothing comes down it - a backgrounded tab,
    // a phone that lost signal. Coasting in a straight line looks broken.
    const t = new RemoteInputTracker(1000);
    t.set(3, INPUT(), 1000);
    expect(t.current(1900).has(3)).toBe(true);
    expect(t.current(2500).has(3)).toBe(false);
  });

  it('names the seats that have gone quiet', () => {
    const t = new RemoteInputTracker(1000);
    t.set(3, INPUT(), 1000);
    t.set(4, INPUT(), 2400);
    expect(t.stale(2500)).toEqual([3]);
  });

  it('keeps a rider alive as long as they keep sending', () => {
    const t = new RemoteInputTracker(1000);
    t.set(3, INPUT(), 1000);
    t.set(3, INPUT(), 1800);
    t.set(3, INPUT(), 2600);
    expect(t.current(2700).has(3)).toBe(true);
  });

  it('drops a rider who left', () => {
    const t = new RemoteInputTracker();
    t.set(3, INPUT(), 1000);
    t.drop(3);
    expect(t.current(1000).has(3)).toBe(false);
  });

  it('empties on clear', () => {
    const t = new RemoteInputTracker();
    t.set(1, INPUT(), 1000);
    t.set(2, INPUT(), 1000);
    t.clear();
    expect(t.current(1000).size).toBe(0);
  });

  it('reports an empty grid as nobody riding, not as an error', () => {
    expect(new RemoteInputTracker().current(0).size).toBe(0);
  });
});

describe('rate limiting', () => {
  it('fires immediately, then waits', () => {
    const t = Ticker.atHz(20); // every 50ms
    expect(t.due(1000)).toBe(true);
    expect(t.due(1020)).toBe(false);
    expect(t.due(1050)).toBe(true);
  });

  it('does not fire a burst after a stall', () => {
    // A backgrounded tab must not come back and send a second of catch-up
    // frames all at once.
    const t = Ticker.atHz(20);
    t.due(1000);
    expect(t.due(5000)).toBe(true);
    expect(t.due(5010)).toBe(false);
    expect(t.due(5060)).toBe(true);
  });

  it('honours the rate it was asked for', () => {
    const t = Ticker.atHz(10);
    let fired = 0;
    for (let ms = 0; ms < 1000; ms += 10) if (t.due(ms)) fired++;
    expect(fired).toBe(10);
  });
});

describe('room codes', () => {
  it('only ever generates codes the rules will accept', () => {
    // The alphabet in lobby.ts and the pattern in database.rules.json are two
    // copies of one decision. This is the test that keeps them honest: a code
    // the generator emits but the rules reject makes rooms uncreatable.
    const RULE = /^[A-HJ-NP-RT-Z2-46-9]{4}$/;
    for (let i = 0; i < 2000; i++) {
      expect(makeRoomCode(), `attempt ${i}`).toMatch(RULE);
    }
  });

  it('avoids the characters people misread aloud', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) for (const c of makeRoomCode()) seen.add(c);
    for (const banned of ['I', 'O', 'S', '0', '1', '5']) {
      expect([...seen], `should never emit ${banned}`).not.toContain(banned);
    }
  });

  it('tidies whatever the player typed', () => {
    expect(normaliseRoomCode(' qx-47 ')).toBe('QX47');
    expect(normaliseRoomCode('ab23extra')).toBe('AB23');
  });

  it('reports a code that could never be valid as too short', () => {
    expect(normaliseRoomCode('!!')).toBe('');
    expect(normaliseRoomCode('ab')).toBe('AB');
  });
});

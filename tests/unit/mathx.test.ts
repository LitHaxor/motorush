import { describe, it, expect } from 'vitest';
import {
  clamp, lerp, damp, approach, makeRng, formatTime, formatShortTime, formatGap,
  ordinal, mps2kmh, formatKm,
} from '../../src/sim/mathx';

describe('mathx', () => {
  it('clamps to the given range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('lerps endpoints exactly', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.25)).toBe(2.5);
  });

  it('damps toward the target and is framerate independent', () => {
    // One 0.1s step must land in the same place as ten 0.01s steps.
    const oneStep = damp(0, 100, 5, 0.1);
    let many = 0;
    for (let i = 0; i < 10; i++) many = damp(many, 100, 5, 0.01);
    expect(many).toBeCloseTo(oneStep, 6);
  });

  it('never overshoots with approach()', () => {
    expect(approach(0, 10, 3)).toBe(3);
    expect(approach(0, 2, 3)).toBe(2);
    expect(approach(0, -2, 3)).toBe(-2);
  });

  it('produces a deterministic stream per seed', () => {
    const a = makeRng(1234);
    const b = makeRng(1234);
    const c = makeRng(5678);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    const seqC = Array.from({ length: 8 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(1);
  });

  it('exposes range/int/pick/chance helpers within bounds', () => {
    const rng = makeRng(99);
    for (let i = 0; i < 200; i++) {
      const r = rng.range(5, 7);
      expect(r).toBeGreaterThanOrEqual(5);
      expect(r).toBeLessThanOrEqual(7);
      const n = rng.int(1, 3);
      expect([1, 2, 3]).toContain(n);
      expect(['a', 'b']).toContain(rng.pick(['a', 'b']));
      expect(typeof rng.chance(0.5)).toBe('boolean');
    }
  });

  it('formats race times as m:ss.mmm', () => {
    expect(formatTime(0)).toBe('0:00.000');
    expect(formatTime(65.5)).toBe('1:05.500');
    expect(formatTime(-1)).toBe('0:00.000');
    expect(formatTime(NaN)).toBe('0:00.000');
  });

  it('builds ordinals for finishing positions', () => {
    expect(ordinal(1)).toBe('1ST');
    expect(ordinal(2)).toBe('2ND');
    expect(ordinal(3)).toBe('3RD');
    expect(ordinal(4)).toBe('4TH');
    expect(ordinal(11)).toBe('11TH');
  });

  it('converts m/s to km/h', () => {
    expect(mps2kmh(10)).toBeCloseTo(36);
  });
});

describe('formatKm', () => {
  it('reports race distances in kilometres', () => {
    expect(formatKm(5200)).toBe('5.20 km');
    expect(formatKm(6600)).toBe('6.60 km');
  });

  it('keeps a short bust legible rather than rounding it to nothing', () => {
    expect(formatKm(179)).toBe('0.18 km');
    expect(formatKm(20)).toBe('0.02 km');
  });

  it('never shows a negative or a NaN distance', () => {
    expect(formatKm(-40)).toBe('0.00 km');
    expect(formatKm(Number.NaN)).toBe('0.00 km');
    expect(formatKm(Number.POSITIVE_INFINITY)).toBe('0.00 km');
  });
});

describe('formatGap', () => {
  it('signs the gap from the reader’s point of view', () => {
    // Up the road is a plus, back down it is a minus - the board is read as
    // "where is everyone in relation to me", not as raw positions.
    expect(formatGap(13)).toBe('+13 m');
    expect(formatGap(-30)).toBe('-30 m');
    expect(formatGap(0)).toBe('+0 m');
  });

  it('rounds to whole metres', () => {
    expect(formatGap(12.4)).toBe('+12 m');
    expect(formatGap(-12.6)).toBe('-13 m');
  });

  it('switches to kilometres once metres stop meaning anything', () => {
    expect(formatGap(1000)).toBe('+1.0 km');
    expect(formatGap(-2340)).toBe('-2.3 km');
    expect(formatGap(999)).toBe('+999 m');
  });

  it('says nothing rather than something wrong', () => {
    expect(formatGap(Number.NaN)).toBe('');
    expect(formatGap(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('formatShortTime', () => {
  it('fits a finishing time into a HUD row', () => {
    expect(formatShortTime(92.46)).toBe('1:32.4');
    expect(formatShortTime(5)).toBe('0:05.0');
    expect(formatShortTime(610.05)).toBe('10:10.0');
  });

  it('never prints nonsense', () => {
    expect(formatShortTime(-3)).toBe('0:00.0');
    expect(formatShortTime(Number.NaN)).toBe('0:00.0');
  });
});

import { describe, it, expect } from 'vitest';
import { Track } from '../../src/sim/track';
import { TRACK } from '../../src/sim/config';

describe('Track', () => {
  it('is deterministic for a given seed', () => {
    const a = new Track({ seed: 21, length: 1200 });
    const b = new Track({ seed: 21, length: 1200 });
    const c = new Track({ seed: 22, length: 1200 });
    expect(Array.from(a.xs)).toEqual(Array.from(b.xs));
    expect(Array.from(a.xs)).not.toEqual(Array.from(c.xs));
  });

  it('starts straight and flat so the grid is fair', () => {
    const t = new Track({ seed: 3, length: 1000 });
    expect(Math.abs(t.curvatureAt(0))).toBeLessThan(1e-6);
    expect(Math.abs(t.elevation(0))).toBeLessThan(1e-6);
    expect(Math.abs(t.headingAt(20))).toBeLessThan(0.01);
  });

  it('keeps curvature inside a rideable radius', () => {
    for (const seed of [1, 2, 3, 40, 500]) {
      const t = new Track({ seed, length: 6000 });
      let maxC = 0;
      for (let s = 0; s < 6000; s += 2) maxC = Math.max(maxC, Math.abs(t.curvatureAt(s)));
      // Anything tighter than a ~120 m radius is undrivable at race speed.
      expect(1 / maxC).toBeGreaterThan(120);
    }
  });

  it('offsets laterally by exactly the requested distance', () => {
    const t = new Track({ seed: 9, length: 2000 });
    for (const s of [0, 137, 900, 1500]) {
      const centre = t.sampleAt(s);
      const right = t.toWorld(s, 6);
      const dist = Math.hypot(right.x - centre.x, right.z - centre.z);
      expect(dist).toBeCloseTo(6, 6);
    }
  });

  it('places positive lateral to the rider\'s right of the centreline', () => {
    const t = new Track({ seed: 5, length: 400 });
    // On the straight opening stretch heading is ~0, so right is +X.
    const p = t.toWorld(20, 4);
    const c = t.sampleAt(20);
    expect(p.x - c.x).toBeCloseTo(4, 3);
  });

  it('classifies on-road, shoulder and out-of-bounds', () => {
    const t = new Track({ seed: 1, length: 400 });
    expect(t.isOffRoad(0)).toBe(false);
    expect(t.isOffRoad(TRACK.halfWidth - 0.1)).toBe(false);
    expect(t.isOffRoad(TRACK.halfWidth + 0.1)).toBe(true);
    expect(t.isOutOfBounds(TRACK.halfWidth + 1)).toBe(false);
    expect(t.isOutOfBounds(TRACK.halfWidth + TRACK.shoulder + 0.1)).toBe(true);
    expect(t.clampLateral(999)).toBeCloseTo(TRACK.halfWidth + TRACK.shoulder);
    expect(t.clampLateral(-999)).toBeCloseTo(-(TRACK.halfWidth + TRACK.shoulder));
  });

  it('interpolates between samples rather than snapping to them', () => {
    const t = new Track({ seed: 11, length: 1000 });
    const a = t.sampleAt(100);
    const mid = t.sampleAt(102);
    const b = t.sampleAt(104);
    expect(mid.x).toBeGreaterThan(Math.min(a.x, b.x) - 1e-9);
    expect(mid.x).toBeLessThan(Math.max(a.x, b.x) + 1e-9);
    expect(mid.x).not.toBe(a.x);
  });

  it('clamps lookups past the end of the generated track', () => {
    const t = new Track({ seed: 1, length: 500 });
    const past = t.sampleAt(99999);
    expect(Number.isFinite(past.x)).toBe(true);
    expect(Number.isFinite(past.heading)).toBe(true);
  });
});

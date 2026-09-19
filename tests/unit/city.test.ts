import { describe, it, expect } from 'vitest';
import { buildCitySegments, inCity, cityBlend, CITY } from '../../src/sim/city';
import { makeRng } from '../../src/sim/mathx';

describe('city layout', () => {
  it('lays out non-overlapping built-up stretches along the track', () => {
    const segs = buildCitySegments(6000, makeRng(7));
    expect(segs.length).toBeGreaterThan(1);
    for (const seg of segs) {
      expect(seg.to).toBeGreaterThan(seg.from);
      expect(seg.to - seg.from).toBeGreaterThanOrEqual(CITY.length[0] - 1);
      expect(seg.to).toBeLessThanOrEqual(6000);
    }
    // Ordered, with open country in between.
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].from).toBeGreaterThan(segs[i - 1].to + CITY.gap[0] - 1);
    }
  });

  it('is deterministic for a seed', () => {
    expect(buildCitySegments(5000, makeRng(3))).toEqual(buildCitySegments(5000, makeRng(3)));
    expect(buildCitySegments(5000, makeRng(3))).not.toEqual(buildCitySegments(5000, makeRng(4)));
  });

  it('leaves short tracks without a city at all', () => {
    expect(buildCitySegments(200, makeRng(1))).toEqual([]);
  });

  it('reports whether a point is in town, with a margin', () => {
    const segs = [{ from: 1000, to: 1500 }];
    expect(inCity(segs, 1200)).toBe(true);
    expect(inCity(segs, 500)).toBe(false);
    expect(inCity(segs, 2000)).toBe(false);
    // Just outside the segment but inside the margin.
    expect(inCity(segs, 1000 - CITY.margin + 1)).toBe(true);
    expect(inCity(segs, 1000 - CITY.margin - 1)).toBe(false);
    expect(inCity([], 1200)).toBe(false);
  });

  it('ramps the city blend in and out rather than snapping', () => {
    const segs = [{ from: 1000, to: 1500 }];
    expect(cityBlend(segs, 500)).toBe(0);
    expect(cityBlend(segs, 1250)).toBe(1);
    const edge = cityBlend(segs, 1000 - 35); // halfway up the 70 m ramp
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
    // Monotonic approaching town.
    expect(cityBlend(segs, 960)).toBeGreaterThan(cityBlend(segs, 940));
  });

  it('never exceeds 0..1 where segments are close together', () => {
    const segs = [{ from: 1000, to: 1200 }, { from: 1240, to: 1400 }];
    for (let s = 900; s < 1500; s += 5) {
      const v = cityBlend(segs, s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

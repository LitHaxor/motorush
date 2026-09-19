// The biome layout decides terrain, ground cover, props and water, so all of
// those only line up if it is deterministic and well-formed.

import { describe, it, expect } from 'vitest';
import {
  buildBiomes, biomeAt, blendAt, coastAt, segmentAt, citySegments, inCity, BIOME,
} from '../../src/sim/biomes';
import { makeRng } from '../../src/sim/mathx';

describe('biome layout', () => {
  it('lays out ordered, non-overlapping stretches with country between', () => {
    const segs = buildBiomes(9000, makeRng(7));
    expect(segs.length).toBeGreaterThan(2);
    for (const seg of segs) {
      expect(seg.to).toBeGreaterThan(seg.from);
      expect(seg.to).toBeLessThanOrEqual(9000);
    }
    for (let i = 1; i < segs.length; i++) {
      // A gap of open country separates every feature.
      expect(segs[i].from).toBeGreaterThan(segs[i - 1].to + BIOME.gap[0] - 1);
    }
  });

  it('never repeats the same biome back to back', () => {
    for (const seed of [1, 2, 3, 99, 4242]) {
      const segs = buildBiomes(12000, makeRng(seed));
      for (let i = 1; i < segs.length; i++) {
        expect(segs[i].kind).not.toBe(segs[i - 1].kind);
      }
    }
  });

  it('is deterministic for a seed', () => {
    expect(buildBiomes(8000, makeRng(11))).toEqual(buildBiomes(8000, makeRng(11)));
    expect(buildBiomes(8000, makeRng(11))).not.toEqual(buildBiomes(8000, makeRng(12)));
  });

  it('produces every biome type across enough seeds', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed < 60; seed++) {
      for (const seg of buildBiomes(9000, makeRng(seed))) seen.add(seg.kind);
    }
    expect([...seen].sort()).toEqual(
      ['city', 'coast', 'hills', 'jungle', 'mountain', 'paddy', 'village'],
    );
  });

  it('leaves a short track as open country', () => {
    expect(buildBiomes(200, makeRng(1))).toEqual([]);
    expect(biomeAt([], 100)).toBe('country');
  });

  it('reports the biome at a point, defaulting to country', () => {
    const segs = [{ from: 1000, to: 1500, kind: 'jungle' as const, side: 0 as const }];
    expect(biomeAt(segs, 1200)).toBe('jungle');
    expect(biomeAt(segs, 500)).toBe('country');
    expect(segmentAt(segs, 1200)?.kind).toBe('jungle');
    expect(segmentAt(segs, 500)).toBeNull();
  });

  it('ramps the blend in and out rather than snapping', () => {
    const segs = [{ from: 1000, to: 1500, kind: 'hills' as const, side: 0 as const }];
    expect(blendAt(segs, 500, 'hills')).toBe(0);
    expect(blendAt(segs, 1250, 'hills')).toBe(1);
    const edge = blendAt(segs, 1000 - BIOME.ramp / 2, 'hills');
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
    // Asking for a biome that is not there gives nothing.
    expect(blendAt(segs, 1250, 'jungle')).toBe(0);
  });

  it('keeps the blend inside 0..1 everywhere', () => {
    const segs = buildBiomes(6000, makeRng(5));
    for (let s = 0; s < 6000; s += 25) {
      const kinds = ['city', 'jungle', 'hills', 'coast', 'paddy', 'mountain', 'village'] as const;
      for (const kind of kinds) {
        const v = blendAt(segs, s, kind);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('puts the sea on one definite side of a coast section', () => {
    const segs = buildBiomes(14000, makeRng(3)).filter((s) => s.kind === 'coast');
    for (const seg of segs) {
      expect([-1, 1]).toContain(seg.side);
      const mid = coastAt([seg], (seg.from + seg.to) / 2);
      expect(mid.side).toBe(seg.side);
      expect(mid.blend).toBe(1);
    }
    // Nowhere near a coast, there is no sea and no side.
    expect(coastAt(segs, -5000)).toEqual({ side: 0, blend: 0 });
  });

  it('still answers the city questions the rest of the code asks', () => {
    const segs = buildBiomes(14000, makeRng(9));
    const cities = citySegments(segs);
    expect(cities.every((c) => c.to > c.from)).toBe(true);
    for (const c of cities) expect(inCity(segs, (c.from + c.to) / 2)).toBe(true);
  });
});

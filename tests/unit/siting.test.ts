import { describe, it, expect } from 'vitest';
import { chordBow, clearsRoad, islandDepth, outerSetback } from '../../src/render/siting';
import { TRACK, CITY } from '../../src/sim/config';

describe('how far a straight block bows off a curving road', () => {
  it('is nothing at all on a straight', () => {
    expect(chordBow(50, 0)).toBe(0);
    expect(chordBow(0, 0.01)).toBe(0);
  });

  it('grows with the square of the length', () => {
    // Doubling a terrace quadruples how far its ends swing out, which is why
    // the long prototypes were the ones that ended up in the road.
    expect(chordBow(40, 0.01)).toBeCloseTo(chordBow(20, 0.01) * 4, 6);
  });

  it('matches the sagitta of the chord', () => {
    // L²/8R, checked against the radius directly rather than the curvature.
    const radius = 200;
    expect(chordBow(50, 1 / radius)).toBeCloseTo((50 * 50) / (8 * radius), 9);
  });

  it('does not care which way the road bends', () => {
    expect(chordBow(30, -0.008)).toBeCloseTo(chordBow(30, 0.008), 9);
  });

  it('refuses to return nonsense', () => {
    expect(chordBow(Number.NaN, 0.01)).toBe(0);
    expect(chordBow(30, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('keeping buildings off the tarmac', () => {
  const edge = TRACK.halfWidth;

  it('pushes a row beside the road out by the bow', () => {
    const straight = outerSetback(edge, CITY.buildingSetback, 0);
    const bend = outerSetback(edge, CITY.buildingSetback, 2.4);
    expect(bend - straight).toBeCloseTo(2.4, 9);
    expect(straight).toBe(edge + CITY.buildingSetback);
  });

  it('leaves an island block its pavement and the bow', () => {
    // A 9m half-width island with 2.6m pavements has 12.8m to build on when
    // the road is straight, and less as it bends.
    expect(islandDepth(9, CITY.islandPavement, 0)).toBeCloseTo(12.8, 6);
    expect(islandDepth(9, CITY.islandPavement, 1.5)).toBeCloseTo(9.8, 6);
  });

  it('gives up rather than going negative on a narrow island', () => {
    expect(islandDepth(2, CITY.islandPavement, 0)).toBe(0);
    expect(islandDepth(9, CITY.islandPavement, 40)).toBe(0);
  });

  it('accepts a footprint that clears the road and rejects one that does not', () => {
    // Beside the road: centre 20m out, 7m deep, on a bend.
    expect(clearsRoad(20, 3.5, 1.2, edge)).toBe(true);
    expect(clearsRoad(11, 3.5, 1.2, edge)).toBe(false);
    // The mirror image has to behave the same, or the far side of the road
    // quietly stops being checked.
    expect(clearsRoad(-20, 3.5, 1.2, edge)).toBe(true);
    expect(clearsRoad(-11, 3.5, 1.2, edge)).toBe(false);
  });

  it('holds for an island block sized by the rule', () => {
    // The two halves of the rule have to agree: a block cut to islandDepth
    // must then pass clearsRoad against the carriageway it sits between.
    for (const median of [5, 7, 9, 12]) {
      for (const bow of [0, 0.8, 2]) {
        const depth = islandDepth(median, CITY.islandPavement, bow);
        if (depth === 0) continue;
        // Its edge, measured from the island centre, against the carriageway.
        const reach = depth / 2 + bow;
        expect(reach).toBeLessThanOrEqual(median - CITY.islandPavement + 1e-9);
      }
    }
  });
});

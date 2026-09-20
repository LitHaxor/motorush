// Pedestrians are the main thing that makes a city stretch feel inhabited, and
// the only scenery you can actually hit, so the placement rules matter.

import { describe, it, expect } from 'vitest';
import { generatePedestrians, stepPedestrians, PED } from '../../src/sim/pedestrians';
import { makeRng } from '../../src/sim/mathx';
import { createRacer } from '../../src/sim/racer';
import { TRACK } from '../../src/sim/config';

const CITY = [{ from: 1000, to: 1600 }];

/**
 * A plain undivided road, where the tarmac stops at the usual half-width.
 *
 * Pedestrians place themselves against the kerb rather than against a constant,
 * so they need to be told where it is. `WIDE` is the same street after it has
 * split into two carriageways, which is where they used to end up in a lane.
 */
const ROAD = { edgeAt: () => TRACK.halfWidth };
const WIDE = { edgeAt: () => TRACK.halfWidth * 2 };

describe('pedestrians', () => {
  it('puts walkers on both pavements through a city', () => {
    const { pedestrians } = generatePedestrians(CITY, makeRng(4), ROAD);
    const walkers = pedestrians.filter((p) => p.kind === 'walker');
    expect(walkers.length).toBeGreaterThan(4);
    expect(walkers.some((w) => w.lateral > 0)).toBe(true);
    expect(walkers.some((w) => w.lateral < 0)).toBe(true);
    // On the pavement, clear of the carriageway.
    for (const w of walkers) {
      expect(Math.abs(w.lateral)).toBeGreaterThan(TRACK.halfWidth);
    }
  });

  it('walks them along the pavement and turns them round at the block end', () => {
    const { pedestrians } = generatePedestrians(CITY, makeRng(4), ROAD);
    const walker = pedestrians.find((p) => p.kind === 'walker')!;
    walker.s = walker.maxS - 0.2;
    walker.along = 1;
    const lateral = walker.lateral;
    for (let i = 0; i < 120; i++) stepPedestrians(pedestrians, [], walker.s, 1 / 60);
    expect(walker.along).toBe(-1);
    expect(walker.s).toBeLessThanOrEqual(walker.maxS + 1e-6);
    // They walk along the road, not into it.
    expect(walker.lateral).toBeCloseTo(lateral, 6);
  });

  it('still lays out crossers and a start-line crowd', () => {
    const { pedestrians, crossings } = generatePedestrians(CITY, makeRng(4), ROAD);
    expect(crossings.length).toBeGreaterThan(0);
    expect(pedestrians.some((p) => p.kind === 'crosser')).toBe(true);
    expect(pedestrians.filter((p) => p.kind === 'spectator').length).toBeGreaterThan(5);
    expect(pedestrians.some((p) => p.kind === 'marshal')).toBe(true);
  });

  it('launches a walker who gets clattered', () => {
    const { pedestrians } = generatePedestrians(CITY, makeRng(4), ROAD);
    const walker = pedestrians.find((p) => p.kind === 'walker')!;
    const rider = createRacer({ id: 1, s: walker.s, lateral: walker.lateral, speed: 40 });
    const events = stepPedestrians(pedestrians, [rider], rider.s, 1 / 60);
    expect(events.some((e) => e.type === 'pedestrianHit')).toBe(true);
    expect(walker.state).toBe('flying');
  });

  it('is deterministic for a seed', () => {
    const a = generatePedestrians(CITY, makeRng(9), ROAD).pedestrians.map((p) => [p.kind, +p.s.toFixed(3)]);
    const b = generatePedestrians(CITY, makeRng(9), ROAD).pedestrians.map((p) => [p.kind, +p.s.toFixed(3)]);
    expect(a).toEqual(b);
  });

  it('leaves a track with no city without walkers', () => {
    const { pedestrians } = generatePedestrians([], makeRng(2), ROAD);
    expect(pedestrians.some((p) => p.kind === 'walker')).toBe(false);
    // The start-line crowd is not tied to a city.
    expect(pedestrians.length).toBe(PED.startCrowd);
  });
});

describe('pedestrians keep to the pavement when the road widens', () => {
  const onTarmac = (p: { lateral: number }, edge: number) => Math.abs(p.lateral) <= edge;

  it('places nobody on an undivided road', () => {
    const { pedestrians } = generatePedestrians(CITY, makeRng(11), ROAD);
    const standing = pedestrians.filter((p) => p.state !== 'walking');
    expect(standing.every((p) => !onTarmac(p, TRACK.halfWidth))).toBe(true);
  });

  it('places nobody on a divided road either', () => {
    // The bug: the pavement was worked out from TRACK.halfWidth, so where the
    // road opened into two carriageways the walkers stayed at the old kerb -
    // which by then was the middle of a lane.
    const { pedestrians } = generatePedestrians(CITY, makeRng(11), WIDE);
    const standing = pedestrians.filter((p) => p.state !== 'walking');
    expect(standing.every((p) => !onTarmac(p, TRACK.halfWidth * 2))).toBe(true);
  });

  it('measures each walker from the kerb, not from the centre', () => {
    const narrow = generatePedestrians(CITY, makeRng(5), ROAD).pedestrians
      .filter((p) => p.kind === 'walker');
    const wide = generatePedestrians(CITY, makeRng(5), WIDE).pedestrians
      .filter((p) => p.kind === 'walker');
    // Same seed, same people - standing further out because the kerb is.
    expect(wide).toHaveLength(narrow.length);
    for (let i = 0; i < narrow.length; i++) {
      expect(Math.abs(wide[i].lateral)).toBeCloseTo(
        Math.abs(narrow[i].lateral) + TRACK.halfWidth, 6,
      );
      expect(wide[i].kerbOffset).toBeCloseTo(narrow[i].kerbOffset, 6);
    }
  });

  it('follows the kerb outwards as a stroller walks into a split', () => {
    const { pedestrians } = generatePedestrians(CITY, makeRng(7), ROAD);
    const walker = pedestrians.find((p) => p.kind === 'walker')!;
    walker.state = 'strolling';
    const before = Math.abs(walker.lateral);
    // The same walker, now on a stretch where the road has opened up.
    stepPedestrians([walker], [], walker.s, 1 / 60, WIDE);
    expect(Math.abs(walker.lateral)).toBeCloseTo(before + TRACK.halfWidth, 4);
  });
});

// Pedestrians are the main thing that makes a city stretch feel inhabited, and
// the only scenery you can actually hit, so the placement rules matter.

import { describe, it, expect } from 'vitest';
import { generatePedestrians, stepPedestrians, PED } from '../../src/sim/pedestrians';
import { makeRng } from '../../src/sim/mathx';
import { createRacer } from '../../src/sim/racer';
import { TRACK } from '../../src/sim/config';

const CITY = [{ from: 1000, to: 1600 }];

describe('pedestrians', () => {
  it('puts walkers on both pavements through a city', () => {
    const { pedestrians } = generatePedestrians(CITY, makeRng(4));
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
    const { pedestrians } = generatePedestrians(CITY, makeRng(4));
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
    const { pedestrians, crossings } = generatePedestrians(CITY, makeRng(4));
    expect(crossings.length).toBeGreaterThan(0);
    expect(pedestrians.some((p) => p.kind === 'crosser')).toBe(true);
    expect(pedestrians.filter((p) => p.kind === 'spectator').length).toBeGreaterThan(5);
    expect(pedestrians.some((p) => p.kind === 'marshal')).toBe(true);
  });

  it('launches a walker who gets clattered', () => {
    const { pedestrians } = generatePedestrians(CITY, makeRng(4));
    const walker = pedestrians.find((p) => p.kind === 'walker')!;
    const rider = createRacer({ id: 1, s: walker.s, lateral: walker.lateral, speed: 40 });
    const events = stepPedestrians(pedestrians, [rider], rider.s, 1 / 60);
    expect(events.some((e) => e.type === 'pedestrianHit')).toBe(true);
    expect(walker.state).toBe('flying');
  });

  it('is deterministic for a seed', () => {
    const a = generatePedestrians(CITY, makeRng(9)).pedestrians.map((p) => [p.kind, +p.s.toFixed(3)]);
    const b = generatePedestrians(CITY, makeRng(9)).pedestrians.map((p) => [p.kind, +p.s.toFixed(3)]);
    expect(a).toEqual(b);
  });

  it('leaves a track with no city without walkers', () => {
    const { pedestrians } = generatePedestrians([], makeRng(2));
    expect(pedestrians.some((p) => p.kind === 'walker')).toBe(false);
    // The start-line crowd is not tied to a city.
    expect(pedestrians.length).toBe(PED.startCrowd);
  });
});

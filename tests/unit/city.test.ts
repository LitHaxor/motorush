// The city street is laid out by three different files - the pavement mesh,
// the building line and the people walking on it. They agree only because
// they read the same constants, so these tests guard the agreement rather
// than any one of the three.

import { describe, it, expect } from 'vitest';
import { CITY, TRACK } from '../../src/sim/config';
import { World } from '../../src/sim/world';

/** Where the rideable corridor ends, measured from the tarmac edge. */
const BARRIER = TRACK.shoulder;

describe('how a street is laid out', () => {
  it('runs the pavement all the way to the buildings', () => {
    // A shortfall here is a strip of parkland grass down every city street,
    // which is what 5.5 against a setback of 8 used to produce.
    expect(CITY.pavementWidth).toBe(CITY.buildingSetback);
  });

  it('puts people on foot outside the barrier', () => {
    // Anything inside this is standing in the road.
    expect(CITY.walkway[0]).toBeGreaterThan(BARRIER);
  });

  it('keeps people on foot out of the walls', () => {
    expect(CITY.walkway[1]).toBeLessThan(CITY.buildingSetback);
  });

  it('leaves the walkway a usable width', () => {
    expect(CITY.walkway[1]).toBeGreaterThan(CITY.walkway[0]);
  });
});

describe('where the city crowd actually stands', () => {
  const worldWithCity = () => {
    for (const seed of [1, 3, 7, 11, 21, 42]) {
      const w = new World({ seed });
      if (w.pedestrians.some((p) => p.kind === 'walker')) return w;
    }
    throw new Error('no seed produced a city with walkers');
  };

  it('puts every pavement walker on the pavement', () => {
    const w = worldWithCity();
    const walkers = w.pedestrians.filter((p) => p.kind === 'walker');
    expect(walkers.length).toBeGreaterThan(0);

    for (const p of walkers) {
      const out = Math.abs(p.lateral) - TRACK.halfWidth;
      // Past the barrier, so never in the carriageway...
      expect(out, `walker at ${p.lateral.toFixed(1)}`).toBeGreaterThan(BARRIER);
      // ...and short of the building line, so never inside a wall.
      expect(out, `walker at ${p.lateral.toFixed(1)}`).toBeLessThanOrEqual(CITY.buildingSetback);
    }
  });

  it('keeps the start-line crowd off the racing line', () => {
    const w = new World({ seed: 5 });
    const crowd = w.pedestrians.filter((p) => p.kind === 'spectator' || p.kind === 'marshal');
    for (const p of crowd) {
      expect(Math.abs(p.lateral)).toBeGreaterThan(TRACK.halfWidth);
    }
  });
});

describe('street furniture stays out of the road', () => {
  it('waits crossers on the kerb, not in the carriageway', () => {
    // A crosser starts at the pavement edge and walks over. Starting inside
    // the barrier put them standing about in the middle of the street.
    const w = new World({ seed: 7 });
    const crossers = w.pedestrians.filter((p) => p.kind === 'crosser');
    expect(crossers.length).toBeGreaterThan(0);

    const starts = crossers.map((p) => Math.abs(p.lateral) - TRACK.halfWidth);
    expect(Math.max(...starts)).toBeGreaterThan(BARRIER);
    expect(Math.min(...starts)).toBeGreaterThan(BARRIER);
  });

  it('puts the walkway outside the rideable corridor entirely', () => {
    // Everything placed on the walkway - people, signal posts - inherits this,
    // so it is the one number that keeps street furniture off the tarmac.
    expect(CITY.walkway[0]).toBeGreaterThan(TRACK.shoulder);
  });
});

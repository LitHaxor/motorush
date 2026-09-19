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

describe('Track: beyond the baked range', () => {
  it('extrapolates behind the start line instead of collapsing to it', () => {
    const t = new Track({ seed: 3, length: 1000 });
    const start = t.sampleAt(0);
    const behind = t.sampleAt(-10);
    const further = t.sampleAt(-20);
    // Distinct points, receding in a straight line from the start.
    const d1 = Math.hypot(behind.x - start.x, behind.z - start.z);
    const d2 = Math.hypot(further.x - start.x, further.z - start.z);
    expect(d1).toBeCloseTo(10, 4);
    expect(d2).toBeCloseTo(20, 4);
  });

  it('keeps the starting grid from stacking on one spot', () => {
    const t = new Track({ seed: 3, length: 1000 });
    const seen = new Set<string>();
    for (const s of [0, -2.3, -4.6, -6.9]) {
      const p = t.sampleAt(s);
      seen.add(`${p.x.toFixed(3)}:${p.z.toFixed(3)}`);
    }
    expect(seen.size).toBe(4);
  });

  it('extrapolates past the end of the track too', () => {
    const t = new Track({ seed: 3, length: 500 });
    const end = t.sampleAt(500);
    const past = t.sampleAt(560);
    expect(Math.hypot(past.x - end.x, past.z - end.z)).toBeGreaterThan(50);
    expect(Number.isFinite(past.y)).toBe(true);
  });

  it('still offsets laterally correctly outside the range', () => {
    const t = new Track({ seed: 3, length: 500 });
    const centre = t.sampleAt(-12);
    const right = t.toWorld(-12, 5);
    expect(Math.hypot(right.x - centre.x, right.z - centre.z)).toBeCloseTo(5, 4);
  });
});

describe('Track: divided sections', () => {
  it('lays out ordered divided stretches', () => {
    const t = new Track({ seed: 12, length: 9000 });
    expect(t.divided.length).toBeGreaterThan(0);
    for (let i = 0; i < t.divided.length; i++) {
      expect(t.divided[i].to).toBeGreaterThan(t.divided[i].from);
      if (i > 0) expect(t.divided[i].from).toBeGreaterThan(t.divided[i - 1].to);
    }
  });

  it('has no median on an undivided stretch', () => {
    const t = new Track({ seed: 12, length: 9000 });
    // Well before the first divided section there is nothing in the middle.
    expect(t.medianAt(0)).toBe(0);
    expect(t.isOffRoad(0, 0)).toBe(false);
  });

  it('opens the median gradually rather than under your wheels', () => {
    const t = new Track({ seed: 12, length: 9000 });
    const seg = t.divided[0];
    const outside = t.medianAt(seg.from - 200);
    const edge = t.medianAt(seg.from - 40);
    const middle = t.medianAt((seg.from + seg.to) / 2);
    expect(outside).toBe(0);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(middle);
    expect(middle).toBeCloseTo(TRACK.medianHalfWidth, 5);
  });

  it('does not snatch grip away as the median starts to open', () => {
    // Riding the centre line into a divided section used to drop the bike to
    // off-road grip the instant the median existed at all, which reads as the
    // bike breaking rather than as running onto a verge.
    const t = new Track({ seed: 12, length: 9000 });
    const seg = t.divided[0];
    for (let s = seg.from - TRACK.medianRamp; s < seg.from - 20; s += 5) {
      if (t.medianAt(s) >= TRACK.medianMinEffective) break;
      expect(t.isOffRoad(0, s)).toBe(false);
    }
  });

  it('forgives clipping the edge of the median', () => {
    const t = new Track({ seed: 12, length: 9000 });
    const mid = (t.divided[0].from + t.divided[0].to) / 2;
    const median = t.medianAt(mid);
    // Just inside the painted edge is still fine...
    expect(t.isOffRoad(median - 0.2, mid)).toBe(false);
    // ...well inside it is not.
    expect(t.isOffRoad(0, mid)).toBe(true);
  });

  it('makes the centre of a divided road undrivable but not fatal', () => {
    const t = new Track({ seed: 12, length: 9000 });
    const mid = (t.divided[0].from + t.divided[0].to) / 2;
    // Straddling the middle is grass, so it costs speed...
    expect(t.isOffRoad(0, mid)).toBe(true);
    // ...but it is not a barrier strike; you can steer out of it.
    expect(t.isOutOfBounds(0)).toBe(false);
    // Either carriageway is still perfectly good tarmac.
    expect(t.isOffRoad(4.5, mid)).toBe(false);
    expect(t.isOffRoad(-4.5, mid)).toBe(false);
  });

  it('leaves every traffic lane drivable through a divided section', () => {
    const t = new Track({ seed: 12, length: 9000 });
    const mid = (t.divided[0].from + t.divided[0].to) / 2;
    for (const lane of TRACK.laneCentres) {
      expect(t.isOffRoad(lane, mid)).toBe(false);
    }
  });
});

describe('Track: coast levelling', () => {
  it('flattens the road through a coast section so the sea can be level', () => {
    const biomes = [{ from: 1000, to: 1600, kind: 'coast' as const, side: 1 as const }];
    const t = new Track({ seed: 4, length: 3000, biomes });
    const a = t.elevation(1150);
    const b = t.elevation(1300);
    const c = t.elevation(1450);
    // Near-constant across the middle of the section.
    expect(Math.abs(a - b)).toBeLessThan(0.25);
    expect(Math.abs(b - c)).toBeLessThan(0.25);
    // And a sea height was recorded below it.
    const sea = t.seaLevels.get(1000);
    expect(sea).toBeDefined();
    expect(sea!).toBeLessThan(b);
  });

  it('leaves the rest of the track alone', () => {
    const biomes = [{ from: 1000, to: 1600, kind: 'coast' as const, side: 1 as const }];
    const flat = new Track({ seed: 4, length: 3000, biomes });
    const plain = new Track({ seed: 4, length: 3000 });
    expect(flat.elevation(300)).toBeCloseTo(plain.elevation(300), 6);
    expect(flat.elevation(2600)).toBeCloseTo(plain.elevation(2600), 6);
  });
});

describe('Track: forks', () => {
  const forked = () => {
    for (let seed = 1; seed < 60; seed++) {
      const t = new Track({ seed, length: 12000 });
      const fork = t.divided.find((d) => d.fork);
      if (fork) return { t, fork };
    }
    throw new Error('no fork generated in 60 seeds');
  };

  it('generates splits wide enough to ride either side of', () => {
    const { t, fork } = forked();
    const mid = (fork.from + fork.to) / 2;
    expect(t.isForkAt(mid)).toBe(true);
    expect(t.medianAt(mid)).toBeCloseTo(TRACK.forkHalfWidth, 3);
  });

  it('moves the carriageways outward so each keeps its full width', () => {
    const { t, fork } = forked();
    const mid = (fork.from + fork.to) / 2;
    const median = t.medianAt(mid);
    // Undivided: the edge is just the half width.
    expect(t.edgeAt(0)).toBeCloseTo(t.halfWidth, 6);
    // Forked: the edge has moved out by the island's half width.
    expect(t.edgeAt(mid)).toBeCloseTo(t.halfWidth + median, 6);
    // Both routes are the full width of a carriageway.
    expect(t.edgeAt(mid) - median).toBeCloseTo(t.halfWidth, 6);
  });

  it('leaves a route drivable on each side of the island', () => {
    const { t, fork } = forked();
    const mid = (fork.from + fork.to) / 2;
    const median = t.medianAt(mid);
    const route = median + t.halfWidth / 2;
    expect(t.isOffRoad(route, mid)).toBe(false);
    expect(t.isOffRoad(-route, mid)).toBe(false);
    // The island itself is not drivable.
    expect(t.isOffRoad(0, mid)).toBe(true);
  });

  it('splits and rejoins rather than staying open', () => {
    const { t, fork } = forked();
    expect(t.medianAt(fork.from - TRACK.medianRamp - 30)).toBe(0);
    expect(t.medianAt((fork.from + fork.to) / 2)).toBeGreaterThan(1);
    expect(t.medianAt(fork.to + TRACK.medianRamp + 30)).toBe(0);
  });

  it('never strands a remounting rider on the island', () => {
    const { t, fork } = forked();
    const mid = (fork.from + fork.to) / 2;
    for (const lateral of [-2, 0, 1, 5]) {
      const out = t.clampLateral(lateral, mid);
      expect(t.isOffRoad(out, mid)).toBe(false);
    }
  });

  it('shifts the traffic lanes out around the median', () => {
    const { t, fork } = forked();
    const mid = (fork.from + fork.to) / 2;
    for (const lane of TRACK.laneCentres) {
      const shifted = t.laneAt(lane, mid);
      expect(Math.abs(shifted)).toBeGreaterThan(Math.abs(lane));
      expect(t.isOffRoad(shifted, mid)).toBe(false);
    }
    // No shift where the road is whole.
    expect(t.laneAt(2.25, 0)).toBeCloseTo(2.25, 6);
  });
});

describe('Track: committing to a fork', () => {
  const forked = () => {
    for (let seed = 1; seed < 60; seed++) {
      const t = new Track({ seed, length: 16000 });
      const fork = t.divided.find((d) => d.fork);
      if (fork) return { t, fork };
    }
    throw new Error('no fork generated in 60 seeds');
  };

  it('runs a fork for a kilometre or so', () => {
    const { fork } = forked();
    expect(fork.to - fork.from).toBeGreaterThanOrEqual(TRACK.forkLength[0]);
  });

  it('leaves no way across once the island is open', () => {
    const { t, fork } = forked();
    const mid = (fork.from + fork.to) / 2;
    // Riding into the island is a barrier strike, not a slow patch of grass.
    expect(t.isOutOfBounds(0, mid)).toBe(true);
    expect(t.isOutOfBounds(1, mid)).toBe(true);
    // Both routes remain perfectly safe.
    const route = t.medianAt(mid) + t.halfWidth / 2;
    expect(t.isOutOfBounds(route, mid)).toBe(false);
    expect(t.isOutOfBounds(-route, mid)).toBe(false);
  });

  it('keeps a narrow median survivable', () => {
    for (let seed = 1; seed < 60; seed++) {
      const t = new Track({ seed, length: 16000 });
      const narrow = t.divided.find((d) => !d.fork);
      if (!narrow) continue;
      const mid = (narrow.from + narrow.to) / 2;
      // Grass, not a wall: you lose grip but you can steer out of it.
      expect(t.isOffRoad(0, mid)).toBe(true);
      expect(t.isOutOfBounds(0, mid)).toBe(false);
      return;
    }
    throw new Error('no narrow median generated');
  });

  it('is passable again as the island closes', () => {
    const { t, fork } = forked();
    expect(t.isOutOfBounds(0, fork.from - TRACK.medianRamp - 20)).toBe(false);
    expect(t.isOutOfBounds(0, fork.to + TRACK.medianRamp + 20)).toBe(false);
  });
});

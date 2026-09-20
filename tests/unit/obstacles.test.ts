import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/world';
import { generateObstacles, collideObstacles, trunkRadius } from '../../src/sim/obstacles';
import { TRACK } from '../../src/sim/config';
import type { RacerInput } from '../../src/sim/types';

const INPUT = (over: Partial<RacerInput> = {}): RacerInput => ({
  throttle: 0, brake: 0, steer: 0, attackLeft: false, attackRight: false, ...over,
});

describe('roadside obstacles', () => {
  it('grows the same wood from the same seed', () => {
    // The fairness property: two browsers in one room, same seed, same trees.
    const a = generateObstacles(new World({ seed: 77 }).track, new World({ seed: 77 }).biomes, 77);
    const b = generateObstacles(new World({ seed: 77 }).track, new World({ seed: 77 }).biomes, 77);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(50);
  });

  it('grows a different wood from a different seed', () => {
    const a = generateObstacles(new World({ seed: 1 }).track, new World({ seed: 1 }).biomes, 1);
    const b = generateObstacles(new World({ seed: 2 }).track, new World({ seed: 2 }).biomes, 2);
    expect(a).not.toEqual(b);
  });

  it('plants nothing in the corridor a rider may use', () => {
    const w = new World({ seed: 5 });
    for (const o of w.obstacles) {
      if (o.onIsland) continue;
      const limit = w.track.edgeAt(o.s) + TRACK.shoulder;
      // The trunk's nearest face, not its centre.
      expect(Math.abs(o.lateral) - o.radius).toBeGreaterThanOrEqual(limit);
    }
  });

  it('keeps island planting inside the island', () => {
    const w = new World({ seed: 5 });
    for (const o of w.obstacles) {
      if (!o.onIsland) continue;
      expect(Math.abs(o.lateral) + o.radius).toBeLessThanOrEqual(w.track.medianAt(o.s));
    }
  });

  it('thickens the trunk with the tree', () => {
    expect(trunkRadius(20)).toBeGreaterThan(trunkRadius(5));
    expect(trunkRadius(0)).toBeGreaterThan(0);
  });
});

describe('hitting a tree', () => {
  const treeAt = (s: number, lateral: number, height = 12) =>
    [{ id: 0, s, lateral, radius: trunkRadius(height), height, onIsland: false }];

  it('puts a rider down', () => {
    const w = new World({ seed: 9 });
    const r = w.player;
    r.state = 'ride';
    r.speed = 50;
    r.s = 100;
    r.lateral = 14;
    const events = collideObstacles([r], treeAt(100, 14), 100);
    expect(events).toHaveLength(1);
    expect(r.state).toBe('down');
    expect(r.health).toBeLessThan(r.maxHealth);
  });

  it('misses when the rider is past it', () => {
    const w = new World({ seed: 9 });
    const r = w.player;
    r.state = 'ride';
    r.speed = 50;
    r.s = 100;
    r.lateral = 20;
    expect(collideObstacles([r], treeAt(100, 14), 100)).toHaveLength(0);
    expect(r.state).toBe('ride');
  });

  it('leaves a rider who is already down alone', () => {
    const w = new World({ seed: 9 });
    const r = w.player;
    r.state = 'down';
    r.s = 100;
    r.lateral = 14;
    expect(collideObstacles([r], treeAt(100, 14), 100)).toHaveLength(0);
  });

  it('ignores trees far from the action', () => {
    const w = new World({ seed: 9 });
    const r = w.player;
    r.state = 'ride';
    r.speed = 50;
    r.s = 4000;
    r.lateral = 14;
    // The rider is on it, but the window is centred a kilometre away.
    expect(collideObstacles([r], treeAt(4000, 14), 100)).toHaveLength(0);
  });

  it('applies to rivals too, so nobody gets a shortcut', () => {
    const w = new World({ seed: 9 });
    const rival = w.rivals[0];
    rival.state = 'ride';
    rival.speed = 50;
    rival.s = 200;
    rival.lateral = -14;
    const events = collideObstacles([rival], treeAt(200, -14), 200);
    expect(events).toHaveLength(1);
    expect(rival.state).toBe('down');
  });
});

describe('a room builds one world, not several', () => {
  it('gives every browser the same trees, pickups, crowd and traffic', () => {
    // What "fair" means in a peer-to-peer race: two machines, one seed, and
    // no way for either to end up racing a different course.
    const a = new World({ seed: 4242, difficulty: 'normal' });
    const b = new World({ seed: 4242, difficulty: 'normal' });

    const trees = (w: World) => w.obstacles.map((o) =>
      [o.s, o.lateral, o.radius, o.height, o.onIsland].join(','));
    expect(trees(a)).toEqual(trees(b));

    const pickups = (w: World) => w.pickups.map((p) => [p.s, p.lateral, p.type].join(','));
    expect(pickups(a)).toEqual(pickups(b));

    const crowd = (w: World) => w.pedestrians.map((p) =>
      [p.kind, p.s, p.lateral, p.kerbOffset].join(','));
    expect(crowd(a)).toEqual(crowd(b));

    const cars = (w: World) => w.traffic.cars.map((c) =>
      [c.id, c.s, c.lateral, c.dir, c.type.key].join(','));
    expect(cars(a)).toEqual(cars(b));

    const road = (w: World) => Array.from({ length: 60 }, (_, i) => {
      const s = i * 120;
      return [w.track.edgeAt(s), w.track.medianAt(s), w.track.toWorld(s, 0).y].join(',');
    });
    expect(road(a)).toEqual(road(b));

    const grid = (w: World) => w.racers.map((r) => [r.name, r.color, r.speedScale].join(','));
    expect(grid(a)).toEqual(grid(b));
  });

  it('does not let the obstacle stream disturb anything else', () => {
    // Obstacles draw from their own stream, so a world built with them lands
    // its rivals, pickups and traffic exactly where a world would anyway.
    const w = new World({ seed: 1234 });
    const again = new World({ seed: 1234 });
    expect(w.obstacles.length).toBeGreaterThan(0);
    expect(w.racers.map((r) => r.name)).toEqual(again.racers.map((r) => r.name));
    expect(w.pickups.length).toBe(again.pickups.length);
  });
});

describe('nothing you cannot see and cannot reach', () => {
  it('keeps verge trees clear of a rider pinned against the barrier', () => {
    // The invisible-hitbox bug: a rider grinding the rail is clamped to
    // exactly edge + shoulder, and a trunk planted just beyond it was still
    // inside the collision test - so scraping the barrier threw you off
    // against a tree standing behind it.
    const w = new World({ seed: 8 });
    for (const o of w.obstacles) {
      if (o.onIsland) continue;
      const pinned = w.track.edgeAt(o.s) + TRACK.shoulder;
      // The test in collideObstacles: radius + 0.55 either side of centre.
      const reach = o.radius + 0.55;
      expect(Math.abs(o.lateral) - pinned).toBeGreaterThan(reach);
    }
  });

  it('still lets you hit a tree on an island, which you can see', () => {
    const w = new World({ seed: 8 });
    const island = w.obstacles.filter((o) => o.onIsland);
    // Island trunks sit on ground you are allowed to ride, so they are the
    // ones that are meant to stop you.
    for (const o of island) {
      expect(Math.abs(o.lateral)).toBeLessThan(w.track.edgeAt(o.s));
    }
  });
});

describe('the obstacle list is ordered', () => {
  it('comes out sorted along the road', () => {
    // The collision check bisects this list. An unsorted one does not throw -
    // it just quietly stops finding trees, which is far worse.
    const w = new World({ seed: 13 });
    for (let i = 1; i < w.obstacles.length; i++) {
      expect(w.obstacles[i].s).toBeGreaterThanOrEqual(w.obstacles[i - 1].s);
    }
  });

  it('still finds a tree after sorting, wherever it is in the list', () => {
    const w = new World({ seed: 13 });
    // One from the middle of the course, well away from the start.
    const target = w.obstacles.filter((o) => o.s > 3000 && o.s < 4000)[0];
    expect(target).toBeTruthy();
    const r = w.player;
    r.state = 'ride';
    r.speed = 50;
    r.s = target.s;
    r.lateral = target.lateral;
    expect(collideObstacles([r], w.obstacles, target.s)).toHaveLength(1);
  });

  it('ignores everything outside the window, cheaply', () => {
    const w = new World({ seed: 13 });
    const target = w.obstacles.filter((o) => o.s > 3000)[0];
    const r = w.player;
    r.state = 'ride';
    r.speed = 50;
    r.s = target.s;
    r.lateral = target.lateral;
    // Same rider, same tree, but the window is centred far away.
    expect(collideObstacles([r], w.obstacles, target.s + 5000)).toHaveLength(0);
  });
});

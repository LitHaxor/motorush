import { describe, it, expect } from 'vitest';
import { Track } from '../../src/sim/track';
import { makeRng } from '../../src/sim/mathx';
import { createRacer } from '../../src/sim/racer';
import { generatePickups, collectPickups, PICKUP_TYPES } from '../../src/sim/pickups';
import { PICKUPS, TRACK, COMBAT, BIKE } from '../../src/sim/config';

const track = new Track({ seed: 8, length: 3000 });

describe('pickups', () => {
  it('spreads pickups along the track, on the tarmac, before the line', () => {
    const items = generatePickups(track, makeRng(3), 2500);
    expect(items.length).toBeGreaterThan(3);
    for (const p of items) {
      expect(Math.abs(p.lateral)).toBeLessThan(TRACK.halfWidth);
      expect(p.s).toBeLessThan(2500);
      expect(PICKUP_TYPES).toContain(p.type);
      expect(p.taken).toBe(false);
    }
    // Monotonic and never stacked on top of each other.
    for (let i = 1; i < items.length; i++) {
      expect(items[i].s - items[i - 1].s).toBeGreaterThanOrEqual(PICKUPS.spacing[0]);
    }
  });

  it('is deterministic for a seed', () => {
    const a = generatePickups(track, makeRng(12), 2000);
    const b = generatePickups(track, makeRng(12), 2000);
    expect(a).toEqual(b);
  });

  it('heals without exceeding the cap', () => {
    const r = createRacer({ id: 1, s: 100, lateral: 0 });
    r.health = 90;
    const p = [{ id: 0, s: 100, lateral: 0, type: 'health' as const, taken: false }];
    const events = collectPickups([r], p);
    expect(events.some((e) => e.type === 'pickup')).toBe(true);
    expect(r.health).toBe(r.maxHealth);
    expect(p[0].taken).toBe(true);
  });

  it('hands over a club with a timer', () => {
    const r = createRacer({ id: 1, s: 100, lateral: 0 });
    collectPickups([r], [{ id: 0, s: 100, lateral: 0, type: 'club', taken: false }]);
    expect(r.weapon).toBe('club');
    expect(r.weaponTimer).toBe(COMBAT.weaponDuration);
  });

  it('starts the boost timer', () => {
    const r = createRacer({ id: 1, s: 100, lateral: 0 });
    collectPickups([r], [{ id: 0, s: 100, lateral: 0, type: 'boost', taken: false }]);
    expect(r.boostTimer).toBe(BIKE.boostDuration);
  });

  it('can only be taken once, by one rider', () => {
    const a = createRacer({ id: 1, s: 100, lateral: 0 });
    const b = createRacer({ id: 2, s: 100, lateral: 0.1 });
    const p = [{ id: 0, s: 100, lateral: 0, type: 'health' as const, taken: false }];
    a.health = 10;
    b.health = 10;
    const events = collectPickups([a, b], p);
    expect(events).toHaveLength(1);
    expect(collectPickups([a, b], p)).toHaveLength(0);
    expect(a.health + b.health).toBe(10 + 10 + PICKUPS.healthAmount);
  });

  it('is missed if you ride wide of it', () => {
    const r = createRacer({ id: 1, s: 100, lateral: 8 });
    const p = [{ id: 0, s: 100, lateral: 0, type: 'health' as const, taken: false }];
    expect(collectPickups([r], p)).toHaveLength(0);
    expect(p[0].taken).toBe(false);
  });

  it('cannot be collected while down', () => {
    const r = createRacer({ id: 1, s: 100, lateral: 0 });
    r.state = 'down';
    const p = [{ id: 0, s: 100, lateral: 0, type: 'health' as const, taken: false }];
    expect(collectPickups([r], p)).toHaveLength(0);
  });
});

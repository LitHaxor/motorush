import { describe, it, expect } from 'vitest';
import { tagOpacity } from '../../src/render/nametag';

describe('name tag fade', () => {
  it('is fully drawn up close', () => {
    expect(tagOpacity(0)).toBe(1);
    expect(tagOpacity(40)).toBe(1);
  });

  it('is gone in the distance', () => {
    // Eight riders each wearing a label would make the road unreadable, so
    // anything far enough away to be scenery does not get one.
    expect(tagOpacity(75)).toBe(0);
    expect(tagOpacity(400)).toBe(0);
  });

  it('fades rather than popping out', () => {
    const mid = tagOpacity(65);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('never leaves the 0..1 range', () => {
    for (let d = -10; d < 200; d += 3) {
      const o = tagOpacity(d);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(1);
    }
  });

  it('falls off monotonically', () => {
    let last = 1;
    for (let d = 0; d < 120; d += 2) {
      const o = tagOpacity(d);
      expect(o).toBeLessThanOrEqual(last);
      last = o;
    }
  });
});

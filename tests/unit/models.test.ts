// The renderer is not unit-testable as a whole, but the maths that decides how
// big a loaded vehicle should be very much is - and getting it wrong is what
// made the traffic look enormous.

import { describe, it, expect } from 'vitest';
import { fitToBox } from '../../src/render/models';

const SEDAN = { length: 4.5, width: 1.9, height: 1.45 };

describe('fitToBox', () => {
  it('sizes a Z-facing model to the target box on every axis', () => {
    const size = { x: 1.5, y: 1.3, z: 2.55 }; // Kenney's stubby sedan
    const { scale, rotateY } = fitToBox(size, SEDAN);
    expect(rotateY).toBe(0);
    expect(size.z * scale.z).toBeCloseTo(SEDAN.length, 5);
    expect(size.x * scale.x).toBeCloseTo(SEDAN.width, 5);
    expect(size.y * scale.y).toBeCloseTo(SEDAN.height, 5);
  });

  it('handles a model authored along X, and rotates it', () => {
    const size = { x: 2.55, y: 1.3, z: 1.5 };
    const { scale, rotateY } = fitToBox(size, SEDAN);
    expect(rotateY).toBeCloseTo(Math.PI / 2, 5);
    // Scale is in the model's own axes: X is its length here.
    expect(size.x * scale.x).toBeCloseTo(SEDAN.length, 5);
    expect(size.z * scale.z).toBeCloseTo(SEDAN.width, 5);
    expect(size.y * scale.y).toBeCloseTo(SEDAN.height, 5);
  });

  it('does not inflate width and height just because the model is stubby', () => {
    // The bug this replaced: uniform scaling by length made a 1.3-tall model
    // 2.3 m tall once stretched to 4.5 m long.
    const { scale } = fitToBox({ x: 1.5, y: 1.3, z: 2.55 }, SEDAN);
    expect(1.3 * scale.y).toBeLessThan(1.6);
    expect(1.5 * scale.x).toBeLessThan(2.1);
  });

  it('never divides by zero on a degenerate model', () => {
    const { scale } = fitToBox({ x: 0, y: 0, z: 0 }, SEDAN);
    expect(Number.isFinite(scale.x)).toBe(true);
    expect(Number.isFinite(scale.y)).toBe(true);
    expect(Number.isFinite(scale.z)).toBe(true);
  });

  it('matches the collision box the simulation uses', () => {
    for (const dims of [SEDAN, { length: 7.8, width: 2.35, height: 3.1 }]) {
      const size = { x: 1.5, y: 1.4, z: 3.0 };
      const { scale } = fitToBox(size, dims);
      expect(size.z * scale.z).toBeCloseTo(dims.length, 5);
      expect(size.x * scale.x).toBeCloseTo(dims.width, 5);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { fovScaleFor } from '../../src/render/view';

describe('field of view on narrow screens', () => {
  it('leaves a widescreen alone', () => {
    expect(fovScaleFor(16 / 9)).toBe(1);
    expect(fovScaleFor(21 / 9)).toBe(1);
  });

  it('widens as the screen gets narrower', () => {
    // Three's fov is vertical, so a tall screen keeps the sky and loses the
    // road either side. Without this the game feels most zoomed-in on exactly
    // the device with the least screen.
    // Both picked below the clamp, or they would simply come out equal.
    const squarish = fovScaleFor(4 / 3);
    const narrower = fovScaleFor(1);
    expect(squarish).toBeGreaterThan(1);
    expect(narrower).toBeGreaterThan(squarish);
  });

  it('clamps a phone held upright rather than fish-eyeing it', () => {
    // Fully preserving the horizontal view wants ~1.85 here, which reads as
    // the camera backing off down the road.
    expect(fovScaleFor(9 / 19.5)).toBe(1.28);
  });

  it('stops widening before the view distorts', () => {
    expect(fovScaleFor(0.2)).toBeLessThanOrEqual(1.28);
    expect(fovScaleFor(0.01)).toBeLessThanOrEqual(1.28);
  });

  it('never returns something the camera cannot use', () => {
    for (const aspect of [0, -1, NaN, Infinity]) {
      const scale = fovScaleFor(aspect);
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThan(0);
    }
  });

  it('is continuous at the reference aspect', () => {
    const justUnder = fovScaleFor(16 / 9 - 0.001);
    expect(justUnder).toBeGreaterThanOrEqual(1);
    expect(justUnder).toBeLessThan(1.01);
  });
});

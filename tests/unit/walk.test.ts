import { describe, it, expect } from 'vitest';
import { STANDING, walkPose } from '../../src/render/walk';

const TAU = Math.PI * 2;
/** A stride's worth of samples, for the properties that hold all the way round. */
const CYCLE = Array.from({ length: 96 }, (_, i) => walkPose((i / 96) * TAU));

describe('the walk cycle', () => {
  it('walks on two legs, half a stride apart', () => {
    // The definition of a stride: one leg is doing exactly what the other did
    // half a cycle ago.
    for (let i = 0; i < 48; i++) {
      const now = walkPose((i / 96) * TAU);
      const half = walkPose((i / 96) * TAU + Math.PI);
      expect(half.hipL).toBeCloseTo(now.hipR, 6);
      expect(half.kneeL).toBeCloseTo(now.kneeR, 6);
    }
  });

  it('never bends a knee or an elbow the wrong way', () => {
    // A knee that goes negative is a flamingo. Worth asserting rather than
    // eyeballing, because the sign is applied in the rig and easy to invert.
    for (const pose of CYCLE) {
      expect(pose.kneeL).toBeGreaterThanOrEqual(0);
      expect(pose.kneeR).toBeGreaterThanOrEqual(0);
      expect(pose.elbowL).toBeGreaterThanOrEqual(0);
      expect(pose.elbowR).toBeGreaterThanOrEqual(0);
    }
  });

  it('folds the knee while the foot is off the ground, not while it carries', () => {
    // The thigh is furthest back at 3π/2 and furthest forward at π/2. The
    // knee has to be folded on the way through and straight when the foot is
    // planted out front, or the walk reads as a limp.
    const swinging = walkPose(Math.PI * 1.5 + 0.5);
    const planted = walkPose(Math.PI * 0.5);
    expect(swinging.kneeL).toBeGreaterThan(planted.kneeL * 4);
    expect(planted.kneeL).toBeLessThan(0.25);
  });

  it('keeps the knee nearly straight for most of the stride', () => {
    // A sine on its own has the knee visibly bent half the time, which reads
    // as a permanent crouch rather than a walk.
    const bent = CYCLE.filter((p) => p.kneeL > 0.4).length;
    expect(bent / CYCLE.length).toBeLessThan(0.4);
  });

  it('swings the arms opposite the legs', () => {
    for (const pose of CYCLE) {
      // Opposite signs, or both at rest - a product that is never positive.
      expect(pose.shoulderL * pose.hipL).toBeLessThanOrEqual(0);
      expect(Math.abs(pose.shoulderL)).toBeLessThan(Math.abs(pose.hipL) + 1e-9);
    }
  });

  it('bounces twice per stride, and not on average', () => {
    // The hips are highest with the feet together, which happens at both ends
    // of the stride - so the bob runs at double the leg rate.
    const tallest = walkPose(0).bob;
    const shortest = walkPose(Math.PI / 2).bob;
    expect(tallest).toBeGreaterThan(shortest);
    expect(walkPose(Math.PI).bob).toBeCloseTo(tallest, 6);

    const mean = CYCLE.reduce((a, p) => a + p.bob, 0) / CYCLE.length;
    // Averages out, so walking does not sink somebody into the pavement.
    expect(Math.abs(mean)).toBeLessThan(0.006);
  });

  it('is continuous, so a stride never snaps', () => {
    // The property that matters most on screen: no step of the phase, however
    // it is reached, can move a joint further than the step warrants.
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const a = walkPose(i * 0.01);
      const b = walkPose((i + 1) * 0.01);
      worst = Math.max(worst, Math.abs(a.hipL - b.hipL), Math.abs(a.kneeL - b.kneeL));
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('is the same walk at a different size when you hurry', () => {
    const dawdle = walkPose(Math.PI / 2, 0.5);
    const hurry = walkPose(Math.PI / 2, 1);
    expect(Math.abs(hurry.hipL)).toBeGreaterThan(Math.abs(dawdle.hipL));
    // Compared as a range rather than at a point: π/2 is the bottom of the
    // bounce, where a bigger walk is lower, not higher.
    const range = (stride: number) => walkPose(0, stride).bob - walkPose(Math.PI / 2, stride).bob;
    expect(range(1)).toBeGreaterThan(range(0.5));
    // Same shape, just scaled.
    expect(dawdle.hipL / hurry.hipL).toBeCloseTo(0.5, 6);
  });

  it('stands still at stride zero', () => {
    const still = walkPose(1.234, 0);
    expect(still.hipL).toBeCloseTo(0, 12);
    expect(still.hipR).toBeCloseTo(0, 12);
    expect(still.bob).toBeCloseTo(0, 12);
    expect(still.lean).toBeCloseTo(0, 12);
    // Knees and elbows keep their resting bend: nobody stands locked straight.
    expect(still.kneeL).toBeGreaterThan(0);
    expect(still.elbowL).toBeGreaterThan(0);
    expect(STANDING).toEqual(walkPose(0, 0));
  });

  it('clamps a stride that is asked for more than it has', () => {
    expect(walkPose(1, 5).hipL).toBeCloseTo(walkPose(1, 1).hipL, 6);
    expect(walkPose(1, -3).hipL).toBeCloseTo(0, 12);
  });
});

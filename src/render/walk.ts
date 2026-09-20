// A walk cycle, as angles.
//
// Pure: phase in, joint angles out. No Three.js, no rig, nothing to mock - so
// the thing that decides what walking looks like can be reasoned about and
// tested on its own, rather than only by watching somebody walk past at
// 250 km/h.
//
// The whole cycle is one phase running 0..2π per stride. Both legs read the
// same function half a turn apart, which is what a stride is.

/** Angles in radians, in the rig's own convention: positive swings forward. */
export interface WalkPose {
  /** Thigh, from the hip. */
  hipL: number;
  hipR: number;
  /** Shin, from the knee. Never negative - knees do not bend forwards. */
  kneeL: number;
  kneeR: number;
  /** Upper arm, from the shoulder. Opposes the leg on the same side. */
  shoulderL: number;
  shoulderR: number;
  /** Forearm, from the elbow. Also never negative. */
  elbowL: number;
  elbowR: number;
  /** Rise and fall of the hips, in metres. Highest with the feet together. */
  bob: number;
  /** Forward lean of the torso, radians. */
  lean: number;
}

/**
 * Where in the stride the knee is at its most bent.
 *
 * A knee is nearly straight while the foot is on the ground carrying weight,
 * and folds up once the foot leaves it so the toe clears the road. The thigh
 * is furthest back at 3π/2, and the fold peaks just after that, on the way
 * through. Everything else here is timing relative to this.
 */
const KNEE_PEAK = Math.PI * 1.5 + 0.5;
/** Phase offset that puts the peak of (1 - cos) where KNEE_PEAK wants it. */
const KNEE_LAG = KNEE_PEAK - Math.PI;

/** How far the knee folds at full stride, radians. */
const KNEE_MAX = 1.15;
/** A knee is never locked straight, even standing. */
const KNEE_REST = 0.08;

/** Arms hang with a permanent slight bend, and pump a little as they swing. */
const ELBOW_REST = 0.22;
const ELBOW_SWING = 0.45;

/** Hip swing at stride 1, radians. */
const HIP_SWING = 0.62;
/** Arms swing less than legs, and opposite them. */
const ARM_RATIO = 0.62;
/** How far the hips rise and fall over a stride, metres. */
const BOB = 0.035;
const LEAN = 0.09;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * One leg's share of the cycle.
 *
 * `phase` is that leg's own phase, so the other leg is simply this again at
 * `phase + π`.
 */
function leg(phase: number, stride: number): { hip: number; knee: number } {
  const hip = Math.sin(phase) * HIP_SWING * stride;
  // A single smooth fold per stride, peaking mid-swing, and raised to a power
  // so the knee spends most of the cycle nearly straight and folds quickly
  // when it does. A plain sine has it visibly bent for half the stride, which
  // reads as a permanent crouch; squaring was still a third too long. Cubed,
  // the leg is straight through the whole of the stance and snaps up to clear
  // the road, which is what walking actually looks like.
  const fold = (0.5 - 0.5 * Math.cos(phase - KNEE_LAG)) ** 3;
  return { hip, knee: KNEE_REST + fold * KNEE_MAX * stride };
}

/**
 * The pose for a given point in the stride.
 *
 * `stride` scales the whole thing, so a dawdle and a hurry are the same walk
 * at different sizes rather than the same angles at different speeds. Pass 0
 * and you get somebody standing still.
 */
export function walkPose(phase: number, stride = 1): WalkPose {
  const s = clamp01(stride);
  const left = leg(phase, s);
  const right = leg(phase + Math.PI, s);

  // Arms oppose the legs: left arm forward with the right leg. The elbow
  // closes as the arm comes forward, which is what stops a swinging arm
  // reading as a rope.
  const shoulderL = -left.hip * ARM_RATIO;
  const shoulderR = -right.hip * ARM_RATIO;

  return {
    hipL: left.hip,
    hipR: right.hip,
    kneeL: left.knee,
    kneeR: right.knee,
    shoulderL,
    shoulderR,
    elbowL: ELBOW_REST + clamp01(shoulderL / HIP_SWING) * ELBOW_SWING * s,
    elbowR: ELBOW_REST + clamp01(shoulderR / HIP_SWING) * ELBOW_SWING * s,
    // Feet together is the tallest point of a stride and feet apart the
    // shortest, and it happens twice per cycle - which is why a walk bounces
    // at double the rate the legs swing at.
    bob: (Math.abs(Math.cos(phase)) - 0.5) * BOB * s,
    lean: LEAN * s,
  };
}

/** Standing still: the pose a walk starts from and returns to. */
export const STANDING: WalkPose = walkPose(0, 0);

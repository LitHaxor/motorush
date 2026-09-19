// Per-racer motion integration. Arcade handling on purpose: speed approaches a
// target exponentially, steering is a direct lateral rate scaled by speed, and
// corners push you toward the outside quadratically.

import { BIKE, CRASH, HEALTH, TRACK } from './config';
import { clamp, damp } from './mathx';
import { isRiding, knockDown, remount, damageRacer, speedCap } from './racer';
import type { Track } from './track';
import type { Racer, RacerInput, SimEvent } from './types';

const GRAVITY = 9.81;

export const NEUTRAL_INPUT: Readonly<RacerInput> = Object.freeze({
  throttle: 0,
  brake: 0,
  steer: 0,
  attackLeft: false,
  attackRight: false,
});

export interface StepContext {
  raceDistance?: number;
  elapsed?: number;
}

/** Lateral push from cornering forces, m/s. Quadratic in speed. */
export function corneringDrift(curvature: number, speed: number): number {
  return curvature * speed * speed * 0.23 * BIKE.driftFactor;
}

/** Steering authority 0..1 - you cannot flick the bike around at walking pace. */
export function steerAuthority(speed: number): number {
  const n = clamp(speed / BIKE.maxSpeed, 0, 1);
  return BIKE.steerLowSpeed + (1 - BIKE.steerLowSpeed) * Math.sqrt(n);
}

function tickTimers(r: Racer, dt: number): void {
  r.attackCooldown = Math.max(0, r.attackCooldown - dt);
  r.weaponTimer = Math.max(0, r.weaponTimer - dt);
  if (r.weaponTimer === 0 && r.weapon !== 'fist') r.weapon = 'fist';
  r.boostTimer = Math.max(0, r.boostTimer - dt);
  r.stagger = Math.max(0, r.stagger - dt);
  if (r.stagger === 0) r.staggerPush = 0;
  r.sinceDamage += dt;
  r.bumpCooldown = Math.max(0, r.bumpCooldown - dt);
  if (r.attackTimer > 0) r.attackTimer = Math.max(0, r.attackTimer - dt);
}

function regenerate(r: Racer, dt: number): void {
  if (r.sinceDamage > HEALTH.regenDelay && r.health > 0) {
    r.health = Math.min(r.maxHealth, r.health + HEALTH.regenRate * dt);
  }
}

/**
 * Advance one racer by `dt`. Returns events (crashes etc.) so the caller can
 * drive audio/FX without the sim knowing anything about them.
 */
export function stepRacer(
  r: Racer,
  track: Track,
  input: Readonly<RacerInput>,
  dt: number,
  ctx: StepContext = {},
): SimEvent[] {
  const events: SimEvent[] = [];
  tickTimers(r, dt);
  regenerate(r, dt);

  if (r.state === 'down') {
    // The bike carries its speed down the road and bleeds it off slowly, so a
    // fast get-off scatters bike and rider a long way.
    r.speed = damp(r.speed, 0, CRASH.slideDrag, dt);
    // Even sliding on your back, a hill still has an opinion.
    r.speed = Math.max(0, r.speed - GRAVITY * track.slopeAt(r.s) * BIKE.slopeFactor * dt);
    r.s += r.speed * dt;

    // Holding the throttle hurries every stage of getting going again.
    const hustle = 1 + clamp(input.throttle ?? 0, 0, 1) * CRASH.hustleBonus;

    switch (r.riderPhase) {
      case 'tumble':
        // Down and sliding. How far is set by the crash speed, not by luck.
        r.riderThrow = damp(r.riderThrow, r.riderThrowTarget, 5, dt);
        r.downTimer -= dt;
        if (r.downTimer <= 0) {
          r.riderPhase = 'standing';
          r.downTimer = CRASH.standTime;
        }
        break;

      case 'standing':
        // Picking yourself up off the tarmac.
        r.downTimer -= dt * hustle;
        if (r.downTimer <= 0) r.riderPhase = 'running';
        break;

      case 'running':
        // Back to the bike on foot.
        r.riderThrow -= CRASH.riderRunSpeed * hustle * dt;
        r.riderLateralThrow = damp(r.riderLateralThrow, 0, 3 * hustle, dt);
        if (r.riderThrow <= 0.05) {
          r.riderThrow = 0;
          r.riderLateralThrow = 0;
          r.riderPhase = 'lifting';
          r.downTimer = CRASH.liftTime;
        }
        break;

      case 'lifting':
        // Hauling it back onto two wheels.
        r.downTimer -= dt * hustle;
        if (r.downTimer <= 0) {
          r.riderPhase = 'mounting';
          r.downTimer = CRASH.mountTime;
        }
        break;

      case 'mounting':
        // Leg over, and away.
        r.downTimer -= dt * hustle;
        if (r.downTimer <= 0) {
          remount(r, track);
          events.push({ type: 'remount', racer: r });
        }
        break;
    }
    return events;
  }

  if (r.state === 'busted') {
    r.speed = damp(r.speed, 0, 3, dt);
    r.s += r.speed * dt;
    return events;
  }

  if (r.state === 'finished') {
    // Roll out past the line rather than stopping dead on it.
    r.speed = damp(r.speed, 0, 0.9, dt);
    r.s += r.speed * dt;
    r.lean = damp(r.lean, 0, 6, dt);
    r.wheelAngle += (r.speed / 0.33) * dt;
    return events;
  }

  if (!isRiding(r)) return events;

  const cap = speedCap(r, track);
  const throttle = clamp(input.throttle ?? 0, 0, 1);
  const brake = clamp(input.brake ?? 0, 0, 1);
  const steer = clamp(input.steer ?? 0, -1, 1);

  // --- longitudinal ---------------------------------------------------
  if (throttle > 0) {
    const target = cap * throttle;
    if (r.speed < target) {
      r.speed = damp(r.speed, target, BIKE.accelRate * (0.65 + 0.35 * throttle), dt);
    } else {
      r.speed -= BIKE.coastDecel * 0.6 * dt;
    }
  } else {
    r.speed -= BIKE.coastDecel * dt;
  }
  if (brake > 0) r.speed -= BIKE.brakeDecel * brake * dt;

  // Gravity along the road. Climbs bleed speed, descents give it back, which
  // makes the hills something you ride rather than just look at.
  const slope = track.slopeAt(r.s);
  r.speed -= GRAVITY * slope * BIKE.slopeFactor * dt;

  // A descent can carry you past the normal cap, but only so far.
  const ceiling = slope < 0 ? cap * BIKE.downhillOverspeed : cap * 1.02;
  r.speed = clamp(r.speed, 0, ceiling);
  if (r.speed > r.bestSpeed) r.bestSpeed = r.speed;

  // --- lateral ---------------------------------------------------------
  const curvature = track.curvatureAt(r.s);
  let dx = steer * BIKE.steerSpeed * steerAuthority(r.speed) * dt;
  dx += corneringDrift(curvature, r.speed) * dt;
  dx += r.staggerPush * dt;
  if (track.isOffRoad(r.lateral)) {
    // Dirt grabs the front wheel and wanders. Deterministic wobble keyed off `s`.
    dx += Math.sin(r.s * 0.9 + r.id * 3.1) * BIKE.offroadRumble * dt;
  }
  r.lateral += dx;
  r.staggerPush = damp(r.staggerPush, 0, 5, dt);

  // Barrier / scenery strike at the very edge of the corridor.
  if (track.isOutOfBounds(r.lateral)) {
    r.lateral = track.clampLateral(r.lateral);
    const fatal = damageRacer(r, HEALTH.barrierDamage);
    if (knockDown(r, 0.85)) {
      events.push({ type: 'crash', racer: r, cause: 'barrier', fatal });
    }
    return events;
  }

  // --- pose + odometry --------------------------------------------------
  const leanTarget = clamp(steer * 0.85 + curvature * r.speed * 0.09, -1, 1) * BIKE.leanMax;
  r.lean = damp(r.lean, leanTarget, 8, dt);
  r.wheelAngle += (r.speed / 0.33) * dt;
  r.s += r.speed * dt;

  // --- finish line -------------------------------------------------------
  const finishAt = ctx.raceDistance ?? TRACK.raceDistance;
  if (r.s >= finishAt) {
    r.state = 'finished';
    r.finishTime = ctx.elapsed ?? 0;
    events.push({ type: 'finish', racer: r });
  }

  return events;
}

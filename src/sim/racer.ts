// A racer is anything on two wheels: the player, a rival, or a cop.
// Pure state + small state-machine helpers, no rendering concerns.

import { BIKE, COMBAT, CRASH, HEALTH } from './config';
import { clamp } from './mathx';
import type { Racer, RacerKind, WeaponType } from './types';
import type { Track } from './track';

export const RIDER_COLORS = [
  0xe23b3b, 0x2f7de1, 0xf2b705, 0x24c07a, 0xb45cf0, 0xff6f2c, 0x19c3d6,
] as const;

export interface RacerOptions {
  id: number;
  kind?: RacerKind;
  name?: string;
  color?: number;
  s?: number;
  lateral?: number;
  speed?: number;
  speedScale?: number;
  aggression?: number;
}

export function createRacer({
  id,
  kind = 'rival',
  name = 'RIDER',
  color = RIDER_COLORS[0],
  s = 0,
  lateral = 0,
  speed = 0,
  speedScale = 1,
  aggression = 0.5,
}: RacerOptions): Racer {
  return {
    id,
    kind,
    name,
    color,

    // Track-space state
    s,
    lateral,
    speed,
    lean: 0,

    // Per-rider capability
    speedScale,
    aggression,

    // Condition
    health: HEALTH.max,
    maxHealth: HEALTH.max,
    state: 'ride',
    downTimer: 0,
    downSeverity: 0,
    sinceDamage: 99,
    stagger: 0,
    staggerPush: 0,

    // Offence
    attackTimer: 0,
    attackCooldown: 0,
    attackDir: 0,
    swingResolved: true,
    weapon: 'fist',
    weaponTimer: 0,
    boostTimer: 0,

    // Bookkeeping / visuals
    wheelAngle: 0,
    bumpCooldown: 0,
    place: 1,
    finishTime: null,
    knockdowns: 0,
    hitsLanded: 0,
    bestSpeed: 0,
    ai: null,
  };
}

export const isRiding = (r: Racer): boolean => r.state === 'ride';
export const isRacing = (r: Racer): boolean => r.state === 'ride' || r.state === 'down';

/** Returns true if this damage put them on zero. */
export function damageRacer(r: Racer, amount: number): boolean {
  r.health = clamp(r.health - amount, 0, r.maxHealth);
  r.sinceDamage = 0;
  return r.health <= 0;
}

/** Put a racer on the tarmac. `severity` 0..1 drives the crash animation. */
export function knockDown(r: Racer, severity = 0.6, downTime: number | null = null): boolean {
  if (r.state !== 'ride') return false;
  const sev = clamp(severity, 0, 1);
  r.state = 'down';
  r.downSeverity = sev;
  const base = r.kind === 'player' ? CRASH.playerDownTime : CRASH.rivalDownTime;
  // A heavier get-off keeps you down longer.
  r.downTimer = downTime ?? base * (1 + sev * CRASH.severityTimeGain);
  // Keep most of the speed: you tumble down the road rather than stopping dead.
  r.speed *= CRASH.slideRetain;
  r.stagger = 0;
  r.attackTimer = 0;
  r.knockdowns += 1;
  return true;
}

export function remount(r: Racer, track: Track): void {
  r.state = 'ride';
  r.speed = CRASH.remountSpeed;
  r.s = Math.max(0, r.s - CRASH.setback);
  // Drag the rider back onto the asphalt so they do not respawn in the trees.
  const limit = track.halfWidth - 1.5;
  r.lateral = clamp(r.lateral, -limit, limit);
  r.lean = 0;
  r.downSeverity = 0;
  if (r.health <= 0) {
    r.health = r.kind === 'player' ? HEALTH.max * 0.35 : CRASH.rivalRespawnHealth;
  }
}

export function giveWeapon(r: Racer, type: WeaponType = 'club'): void {
  r.weapon = type;
  r.weaponTimer = COMBAT.weaponDuration;
}

export function giveBoost(r: Racer): void {
  r.boostTimer = BIKE.boostDuration;
}

/** Speed ceiling for this racer right now, accounting for surface and state. */
export function speedCap(r: Racer, track: Track): number {
  let cap = BIKE.maxSpeed * r.speedScale;
  if (track.isOffRoad(r.lateral)) cap *= BIKE.offroadGrip;
  if (r.boostTimer > 0) cap *= BIKE.boostMultiplier;
  if (r.stagger > 0) cap *= 0.86;
  // Riding hurt costs you top end - keeps fights meaningful.
  const hurt = r.health / r.maxHealth;
  if (hurt < 0.4) cap *= 0.88 + 0.12 * (hurt / 0.4);
  return cap;
}

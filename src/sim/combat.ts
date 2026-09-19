// Melee combat: fists, scavenged clubs and police batons.
//
// A swing has a wind-up before it connects, so attacks can be read and dodged
// rather than being instant hitscan. The strike is resolved once, at the moment
// the arm comes round.

import { COMBAT, CRASH } from './config';
import { isRiding, knockDown, damageRacer } from './racer';
import type { Racer, SimEvent, WeaponType } from './types';

const TOTAL_SWING = COMBAT.windup + COMBAT.swingTime;

export const weaponDamage = (weapon: WeaponType): number => {
  if (weapon === 'club') return COMBAT.clubDamage;
  if (weapon === 'baton') return COMBAT.batonDamage;
  return COMBAT.fistDamage;
};

export function canAttack(r: Racer): boolean {
  return isRiding(r) && r.attackCooldown <= 0 && r.attackTimer <= 0 && r.stagger <= 0;
}

/** Begin a swing. `dir` is -1 (left) or +1 (right). */
export function startAttack(r: Racer, dir: number): boolean {
  if (!canAttack(r)) return false;
  r.attackDir = dir < 0 ? -1 : 1;
  r.attackTimer = TOTAL_SWING;
  r.attackCooldown = COMBAT.cooldown + TOTAL_SWING;
  r.swingResolved = false;
  return true;
}

/** 0..1 across the whole swing - used by the renderer for the arm pose. */
export function swingProgress(r: Racer): number {
  if (r.attackTimer <= 0) return 0;
  return 1 - r.attackTimer / TOTAL_SWING;
}

export function isInReach(attacker: Racer, target: Racer): boolean {
  if (!isRiding(target) || target === attacker) return false;
  const ds = target.s - attacker.s;
  if (Math.abs(ds) > COMBAT.reach) return false;
  const dx = target.lateral - attacker.lateral;
  // Must be on the side you swung at.
  if (dx * attacker.attackDir <= 0) return false;
  return Math.abs(dx) <= COMBAT.lateralReach;
}

export function applyHit(attacker: Racer, victim: Racer): { damage: number; fatal: boolean } {
  const damage = weaponDamage(attacker.weapon);
  const dir = attacker.attackDir;
  const fatal = damageRacer(victim, damage);

  victim.stagger = COMBAT.staggerTime;
  victim.staggerPush = dir * COMBAT.knockLateral * 3.4;
  victim.speed *= COMBAT.speedPenalty;
  // Newton's third law, arcade edition.
  attacker.staggerPush = -dir * COMBAT.knockLateral * 0.5;
  attacker.hitsLanded += 1;

  if (fatal) knockDown(victim, 1, CRASH.knockoutDownTime);
  return { damage, fatal };
}

/**
 * Resolve every swing that reached its strike frame this tick.
 * `racers` is the full field; each attacker hits at most one target (nearest).
 */
export function resolveSwings(racers: readonly Racer[]): SimEvent[] {
  const events: SimEvent[] = [];
  for (const attacker of racers) {
    if (attacker.swingResolved) continue;
    if (attacker.attackTimer > COMBAT.swingTime) continue; // still winding up
    attacker.swingResolved = true;

    let best: Racer | null = null;
    let bestDist = Infinity;
    for (const target of racers) {
      if (!isInReach(attacker, target)) continue;
      const d = Math.abs(target.s - attacker.s) + Math.abs(target.lateral - attacker.lateral);
      if (d < bestDist) {
        bestDist = d;
        best = target;
      }
    }

    const dir = attacker.attackDir === -1 ? -1 : 1;
    if (best) {
      const { damage, fatal } = applyHit(attacker, best);
      events.push({
        type: 'hit',
        attacker,
        victim: best,
        damage,
        weapon: attacker.weapon,
        fatal,
        dir,
      });
    } else {
      events.push({ type: 'whiff', attacker, dir });
    }
  }
  return events;
}

import { describe, it, expect } from 'vitest';
import { createRacer } from '../../src/sim/racer';
import {
  canAttack, startAttack, isInReach, resolveSwings, weaponDamage, swingProgress,
} from '../../src/sim/combat';
import { COMBAT, HEALTH } from '../../src/sim/config';
import { stepRacer } from '../../src/sim/physics';
import { Track } from '../../src/sim/track';
import type { Racer } from '../../src/sim/types';

const track = new Track({ seed: 2, length: 1000, divided: false });
/** Run the swing forward to the frame where it actually connects. */
const advanceToStrike = (rs: Racer[]) => {
  for (const r of rs) stepRacer(r, track, { throttle: 0, brake: 0, steer: 0, attackLeft: false, attackRight: false }, COMBAT.windup + 0.001);
  return resolveSwings(rs);
};

describe('combat', () => {
  it('rates clubs above batons above fists', () => {
    expect(weaponDamage('fist')).toBe(COMBAT.fistDamage);
    expect(weaponDamage('club')).toBe(COMBAT.clubDamage);
    expect(weaponDamage('baton')).toBe(COMBAT.batonDamage);
    expect(weaponDamage('club')).toBeGreaterThan(weaponDamage('fist'));
    // A cop must be able to arrest you before they can kill you, so the baton
    // sits below the club on purpose.
    expect(weaponDamage('baton')).toBeLessThan(weaponDamage('club'));
  });

  it('refuses to swing while on cooldown, staggered or down', () => {
    const r = createRacer({ id: 1 });
    expect(canAttack(r)).toBe(true);
    expect(startAttack(r, 1)).toBe(true);
    expect(canAttack(r)).toBe(false);
    expect(startAttack(r, 1)).toBe(false);

    const staggered = createRacer({ id: 2 });
    staggered.stagger = 0.3;
    expect(canAttack(staggered)).toBe(false);

    const downed = createRacer({ id: 3 });
    downed.state = 'down';
    expect(canAttack(downed)).toBe(false);
  });

  it('only reaches targets on the side it swung at', () => {
    const right = createRacer({ id: 2, s: 100, lateral: 2 });
    const left = createRacer({ id: 3, s: 100, lateral: -2 });

    const swingsRight = createRacer({ id: 1, s: 100, lateral: 0 });
    expect(startAttack(swingsRight, 1)).toBe(true);
    expect(isInReach(swingsRight, right)).toBe(true);
    expect(isInReach(swingsRight, left)).toBe(false);

    // A fresh rider: startAttack is on cooldown for the one above by design.
    const swingsLeft = createRacer({ id: 4, s: 100, lateral: 0 });
    expect(startAttack(swingsLeft, -1)).toBe(true);
    expect(isInReach(swingsLeft, left)).toBe(true);
    expect(isInReach(swingsLeft, right)).toBe(false);
  });

  it('respects longitudinal and lateral reach', () => {
    const a = createRacer({ id: 1, s: 100, lateral: 0 });
    a.attackDir = 1;
    expect(isInReach(a, createRacer({ id: 2, s: 100 + COMBAT.reach + 0.5, lateral: 1 }))).toBe(false);
    expect(isInReach(a, createRacer({ id: 3, s: 100, lateral: COMBAT.lateralReach + 0.5 }))).toBe(false);
    expect(isInReach(a, createRacer({ id: 4, s: 101, lateral: 1 }))).toBe(true);
  });

  it('cannot hit a rider who is already down', () => {
    const a = createRacer({ id: 1, s: 100, lateral: 0 });
    const victim = createRacer({ id: 2, s: 100, lateral: 2 });
    victim.state = 'down';
    a.attackDir = 1;
    expect(isInReach(a, victim)).toBe(false);
  });

  it('lands a hit, damages and shoves the victim sideways', () => {
    const a = createRacer({ id: 1, s: 100, lateral: 0, speed: 50 });
    const victim = createRacer({ id: 2, s: 100.5, lateral: 2, speed: 50 });
    startAttack(a, 1);
    const events = advanceToStrike([a, victim]);
    const hit = events.find((e) => e.type === 'hit');
    expect(hit).toBeDefined();
    expect(victim.health).toBe(HEALTH.max - COMBAT.fistDamage);
    expect(victim.stagger).toBeGreaterThan(0);
    expect(victim.staggerPush).toBeGreaterThan(0); // pushed further right
    expect(victim.speed).toBeLessThan(50);
    expect(a.hitsLanded).toBe(1);
  });

  it('reports a whiff when nothing is in range', () => {
    const a = createRacer({ id: 1, s: 100, lateral: 0 });
    const far = createRacer({ id: 2, s: 300, lateral: 2 });
    startAttack(a, 1);
    const events = advanceToStrike([a, far]);
    expect(events.some((e) => e.type === 'whiff')).toBe(true);
    expect(far.health).toBe(HEALTH.max);
  });

  it('resolves each swing exactly once', () => {
    const a = createRacer({ id: 1, s: 100, lateral: 0 });
    const victim = createRacer({ id: 2, s: 100, lateral: 2 });
    startAttack(a, 1);
    advanceToStrike([a, victim]);
    const again = resolveSwings([a, victim]);
    expect(again).toHaveLength(0);
    expect(victim.health).toBe(HEALTH.max - COMBAT.fistDamage);
  });

  it('knocks a rider down when the hit empties their health', () => {
    const a = createRacer({ id: 1, s: 100, lateral: 0 });
    const victim = createRacer({ id: 2, s: 100, lateral: 2 });
    victim.health = 5;
    startAttack(a, 1);
    const events = advanceToStrike([a, victim]);
    const hit = events.find((e) => e.type === 'hit');
    expect(hit && 'fatal' in hit && hit.fatal).toBe(true);
    expect(victim.state).toBe('down');
    expect(victim.health).toBe(0);
  });

  it('picks the nearest of several targets', () => {
    const a = createRacer({ id: 1, s: 100, lateral: 0 });
    const near = createRacer({ id: 2, s: 100.2, lateral: 1.2 });
    const far = createRacer({ id: 3, s: 102, lateral: 3 });
    startAttack(a, 1);
    advanceToStrike([a, near, far]);
    expect(near.health).toBeLessThan(HEALTH.max);
    expect(far.health).toBe(HEALTH.max);
  });

  it('reports swing progress across the animation', () => {
    const r = createRacer({ id: 1 });
    expect(swingProgress(r)).toBe(0);
    startAttack(r, 1);
    expect(swingProgress(r)).toBeCloseTo(0, 3);
    r.attackTimer = 0.001;
    expect(swingProgress(r)).toBeGreaterThan(0.9);
  });
});

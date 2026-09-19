// Roadside pickups: health, a club to swing, and a nitro boost.

import { PICKUPS, TRACK, HEALTH } from './config';
import { isRiding, giveWeapon, giveBoost } from './racer';
import type { Track } from './track';
import type { Pickup, PickupKind, Racer, Rng, SimEvent } from './types';

export const PICKUP_TYPES: readonly PickupKind[] = ['health', 'club', 'boost'];

function rollType(rng: Rng): PickupKind {
  const w = PICKUPS.weights;
  const total = w.health + w.club + w.boost;
  let roll = rng() * total;
  for (const type of PICKUP_TYPES) {
    roll -= w[type];
    if (roll <= 0) return type;
  }
  return 'health';
}

export function generatePickups(_track: Track, rng: Rng, raceDistance: number): Pickup[] {
  const items: Pickup[] = [];
  let s = 180;
  let id = 0;
  while (s < raceDistance - 80) {
    const lateral = rng.range(-(TRACK.halfWidth - 1.6), TRACK.halfWidth - 1.6);
    items.push({ id: id++, s, lateral, type: rollType(rng), taken: false });
    s += rng.range(PICKUPS.spacing[0], PICKUPS.spacing[1]);
  }
  return items;
}

/** Anyone riding over a pickup grabs it. Returns collection events. */
export function collectPickups(racers: readonly Racer[], pickups: readonly Pickup[]): SimEvent[] {
  const events: SimEvent[] = [];
  for (const p of pickups) {
    if (p.taken) continue;
    for (const r of racers) {
      if (!isRiding(r)) continue;
      if (Math.abs(r.s - p.s) > PICKUPS.radius) continue;
      if (Math.abs(r.lateral - p.lateral) > PICKUPS.radius) continue;

      p.taken = true;
      if (p.type === 'health') {
        r.health = Math.min(r.maxHealth, r.health + PICKUPS.healthAmount);
      } else if (p.type === 'club') {
        giveWeapon(r, 'club');
      } else {
        giveBoost(r);
      }
      events.push({ type: 'pickup', racer: r, pickup: p, kind: p.type });
      break;
    }
  }
  return events;
}

export const MAX_HEALTH = HEALTH.max;

// Opposition brains. Rivals race and brawl; cops only care about you.
//
// Each AI re-plans its target lane a few times a second (staggered per rider so
// the cost is spread across frames) and steers toward it in between.

import { RIVALS, TRACK, BIKE } from './config';
import { clamp } from './mathx';
import { isRiding, speedCap } from './racer';
import { canAttack, startAttack } from './combat';
import type { TrafficSystem } from './traffic';
import type { AiState, Racer, RacerInput, Rng } from './types';
import type { Track } from './track';

const LANE_CANDIDATES = [-7.2, -4.6, -2.1, 0, 2.1, 4.6, 7.2];
const PLAN_INTERVAL = 0.22;
/** How far ahead the AI reads the road layout, in metres. */
const LOOKAHEAD = 110;

/** The slice of the World the AI is allowed to see. */
export interface AiWorldView {
  track: Track;
  traffic: TrafficSystem;
  player: Racer;
  racers: readonly Racer[];
  aggressionScale: number;
  rng: Rng;
}

export function createAiState(rng: Rng): AiState {
  return {
    planTimer: rng.range(0, PLAN_INTERVAL),
    desiredLateral: 0,
    braking: 0,
    attackUrge: 0,
    giveUpTimer: 0,
    bustProgress: 0,
    escapeTimer: 0,
  };
}

/** How far ahead a corridor is clear of traffic, in metres (capped at 120). */
function clearAhead(s: number, lateral: number, traffic: TrafficSystem): number {
  let best = 120;
  for (const car of traffic.cars) {
    if (!car.active) continue;
    if (Math.abs(car.lateral - lateral) > 2.6) continue;
    const gap = car.s - s;
    if (gap < -6 || gap > 120) continue;
    // Oncoming closes far faster than it looks - weight it accordingly.
    const weighted = car.dir === -1 ? gap * 0.45 : gap;
    if (weighted < best) best = Math.max(0, weighted);
  }
  return best;
}

function planLane(r: Racer, world: AiWorldView, ai: AiState): void {
  const { traffic, track } = world;
  let bestScore = -Infinity;
  let bestLateral = r.lateral;

  // Where a median splits the road the lanes move outward, and the middle is
  // no longer a place you can ride. Look ahead as well as underfoot: a fork
  // has to be committed to before it opens, or the rider arrives at the island
  // still straddling the middle.
  const median = track.medianAt(r.s);
  const ahead = Math.max(median, track.medianAt(r.s + LOOKAHEAD));
  const edge = Math.min(track.edgeAt(r.s), track.edgeAt(r.s + LOOKAHEAD));
  // Commit to the side already being ridden; near the middle, take the right,
  // which is the side the race runs on.
  const committed = ahead > 0 ? (r.lateral > 1 ? 1 : r.lateral < -3 ? -1 : 1) : 0;

  for (const base of LANE_CANDIDATES) {
    const cand = base + Math.sign(base) * ahead;
    if (Math.abs(cand) > edge - 1.2) continue;
    if (ahead > 0) {
      if (committed !== 0 && Math.sign(cand) !== committed) continue;
      if (Math.abs(cand) < ahead + 1.2) continue;
    }
    let score = clearAhead(r.s, cand, traffic);
    // Staying on the tarmac and not swerving wildly are both worth something.
    score -= Math.abs(cand - r.lateral) * 1.6;
    // Cars coming the other way live on the left; rivals prefer the right half.
    if (cand < -1) score -= 12;

    if (r.kind === 'cop') {
      score -= Math.abs(cand - world.player.lateral) * 6;
    } else if (ai.attackUrge > 0.5) {
      const target = world.player;
      if (isRiding(target) && Math.abs(target.s - r.s) < 26) {
        score -= Math.abs(cand - target.lateral) * 3.2;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestLateral = cand;
    }
  }
  ai.desiredLateral = bestLateral;
  ai.braking = clearAhead(r.s, r.lateral, traffic) < 26 ? 1 : 0;
}

/** Rubber banding keeps the pack in play without making it obvious. */
function catchupScale(r: Racer, player: Racer): number {
  const gap = player.s - r.s;
  const t = clamp(gap / RIVALS.catchupRange, -1, 1);
  return 1 + t * RIVALS.catchupGain;
}

function nearestVictim(r: Racer, world: AiWorldView): Racer | null {
  let best: Racer | null = null;
  let bestDist = RIVALS.attackRange;
  for (const other of world.racers) {
    if (other === r || !isRiding(other)) continue;
    if (r.kind === 'cop' && other.kind !== 'player') continue;
    if (other.kind === 'cop') continue;
    const ds = Math.abs(other.s - r.s);
    if (ds > RIVALS.attackRange) continue;
    const dx = Math.abs(other.lateral - r.lateral);
    if (dx > 3.4) continue;
    const d = ds + dx;
    if (d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  return best;
}

export function aiInput(r: Racer, world: AiWorldView, dt: number): RacerInput {
  const input: RacerInput = {
    throttle: 1,
    brake: 0,
    steer: 0,
    attackLeft: false,
    attackRight: false,
  };
  const ai = r.ai;
  if (!ai || !isRiding(r)) return input;

  ai.planTimer -= dt;
  if (ai.planTimer <= 0) {
    ai.planTimer = PLAN_INTERVAL;
    planLane(r, world, ai);
  }

  // --- speed ------------------------------------------------------------
  const cap = speedCap(r, world.track);
  let targetSpeed: number;
  if (r.kind === 'cop') {
    const gap = world.player.s - r.s;
    if (world.player.state === 'down') {
      // Ease up and park next to the rider on the floor rather than
      // overshooting them at 250 km/h.
      targetSpeed = clamp(gap * 1.4, 0, cap);
    } else {
      // Otherwise pace them and close the gap, but not infinitely fast.
      targetSpeed = Math.min(cap, Math.max(world.player.speed + 7, BIKE.maxSpeed * 0.72));
    }
  } else {
    targetSpeed = cap * clamp(catchupScale(r, world.player), 0.82, 1.12);
  }
  input.throttle = r.speed < targetSpeed ? 1 : 0.35;
  input.brake = ai.braking && r.speed > 30 ? 0.55 : 0;

  // --- steering ----------------------------------------------------------
  let desired = ai.desiredLateral;
  if (r.kind === 'cop') {
    // Follow the player onto whichever side of a fork they took.
    const edge = world.track.edgeAt(r.s) - 1;
    desired = clamp(world.player.lateral, -edge, edge);
  }
  // Counter the corner so the AI does not drift off the outside of every bend.
  const drift = world.track.curvatureAt(r.s) * r.speed * r.speed * 0.23 * BIKE.driftFactor;
  const correction = (desired - r.lateral) * 0.65 - drift * 0.09;
  input.steer = clamp(correction / 6, -1, 1);

  // --- violence -----------------------------------------------------------
  const aggression = r.kind === 'cop' ? 1.4 : r.aggression * world.aggressionScale;
  ai.attackUrge = clamp(ai.attackUrge + dt * aggression * 0.9, 0, 1.2);
  const victim = nearestVictim(r, world);
  if (victim && canAttack(r) && ai.attackUrge > 0.55) {
    const dir = victim.lateral >= r.lateral ? 1 : -1;
    if (world.rng() < aggression * 0.35) {
      startAttack(r, dir);
      ai.attackUrge = 0;
      if (dir > 0) input.attackRight = true;
      else input.attackLeft = true;
    }
  }

  return input;
}

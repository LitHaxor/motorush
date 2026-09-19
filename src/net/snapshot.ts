// Turning the host's world into something that fits down a wire, and back.

import { CAR_TYPES } from '../sim/traffic';
import type { Pedestrian } from '../sim/pedestrians';
import type { Car, Racer } from '../sim/types';
import { PED_STATES, SNAPSHOT_HZ, type CarSnapshot, type PedSnapshot, type RacerSnapshot, type StateMessage } from './protocol';

const CAR_TYPE_BY_KEY = new Map(CAR_TYPES.map((t) => [t.key, t]));

/** Photograph every rider on the grid. Host side. */
export function captureRacers(racers: readonly Racer[]): RacerSnapshot[] {
  return racers.map((r) => ({
    id: r.id,
    // Rounded on the way out: centimetres and hundredths of a radian are far
    // finer than anything visible, and it roughly halves the frame.
    s: round(r.s, 2),
    lateral: round(r.lateral, 2),
    speed: round(r.speed, 2),
    lean: round(r.lean, 3),
    health: round(r.health, 1),
    hop: round(r.hop, 3),
    state: r.state,
    riderPhase: r.riderPhase,
    attackDir: r.attackDir,
    attackTimer: round(r.attackTimer, 2),
    place: r.place,
    finishTime: r.finishTime == null ? null : round(r.finishTime, 2),
  }));
}

/** Photograph the civilian traffic. About a dozen cars, so cheap to send whole. */
export function captureCars(cars: readonly Car[]): CarSnapshot[] {
  return cars.map((c) => ({
    id: c.id,
    s: round(c.s, 2),
    lateral: round(c.lateral, 2),
    speed: round(c.speed, 2),
    dir: c.dir,
    brake: round(c.brake, 2),
    swerve: round(c.swerve, 3),
    color: c.color,
    type: c.type.key,
  }));
}

/**
 * Write traffic onto the guest's pool.
 *
 * Matched by id because the pool is fixed and recycled - a car that respawned
 * on the host simply arrives here with a new position and type, which is
 * exactly what a recycle looks like from the outside.
 */
export function applyCars(cars: readonly Car[], snapshot: readonly CarSnapshot[]): void {
  const byId = new Map(snapshot.map((c) => [c.id, c]));
  for (const car of cars) {
    const c = byId.get(car.id);
    if (!c) continue;
    car.s = c.s;
    car.lateral = c.lateral;
    car.speed = c.speed;
    car.dir = c.dir;
    car.brake = c.brake;
    car.swerve = c.swerve;
    car.color = c.color;
    const type = CAR_TYPE_BY_KEY.get(c.type);
    if (type) car.type = type;
  }
}

/**
 * Photograph the people near the action.
 *
 * Culled to what is in shot: there are well over a hundred on a track and a
 * guest only needs the ones they might ride into. They are here at all
 * because clipping somebody costs speed, so both ends have to agree on who is
 * standing where.
 */
export function capturePeds(
  peds: readonly Pedestrian[],
  aroundS: number,
  behind = 60,
  ahead = 260,
): PedSnapshot[] {
  const out: PedSnapshot[] = [];
  for (const p of peds) {
    if (p.s < aroundS - behind || p.s > aroundS + ahead) continue;
    const state = PED_STATES.indexOf(p.state as (typeof PED_STATES)[number]);
    out.push([
      p.id,
      round(p.s, 2),
      round(p.lateral, 2),
      round(p.height, 2),
      state < 0 ? 0 : state,
    ]);
  }
  return out;
}

/** Put the people where the host says they are. */
export function applyPeds(peds: readonly Pedestrian[], snapshot: readonly PedSnapshot[]): void {
  const byId = new Map(snapshot.map((p) => [p[0], p]));
  for (const ped of peds) {
    const p = byId.get(ped.id);
    if (!p) continue;
    ped.s = p[1];
    ped.lateral = p[2];
    ped.height = p[3];
    ped.state = PED_STATES[p[4]] ?? ped.state;
  }
}

/** Blend two frames of traffic. Position only; a recycle should snap, not slide. */
export function lerpCars(
  from: readonly CarSnapshot[],
  to: readonly CarSnapshot[],
  t: number,
): CarSnapshot[] {
  const k = Math.min(1, Math.max(0, t));
  const byId = new Map(to.map((c) => [c.id, c]));
  return from.map((a) => {
    const b = byId.get(a.id);
    if (!b) return a;
    // A recycled car teleports to the far end of the window. Interpolating
    // that would fly it back down the road through everyone.
    if (b.type !== a.type || Math.abs(b.s - a.s) > 50) return b;
    return {
      ...a,
      s: a.s + (b.s - a.s) * k,
      lateral: a.lateral + (b.lateral - a.lateral) * k,
      speed: a.speed + (b.speed - a.speed) * k,
      brake: b.brake,
    };
  });
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/**
 * Write an interpolated snapshot onto the guest's own copy of the grid.
 *
 * Only the fields a guest draws are touched. Everything else - the AI state,
 * the timers the sim uses to decide what happens next - is left alone, because
 * on a guest none of it is authoritative anyway.
 */
export function applyRacers(
  racers: readonly Racer[],
  snapshot: readonly RacerSnapshot[],
  /** Our own rider, which is predicted locally and reconciled separately. */
  skipId?: number,
): void {
  const byId = new Map(snapshot.map((s) => [s.id, s]));
  for (const racer of racers) {
    if (racer.id === skipId) continue;
    const s = byId.get(racer.id);
    if (!s) continue;
    racer.s = s.s;
    racer.lateral = s.lateral;
    racer.speed = s.speed;
    racer.lean = s.lean;
    racer.health = s.health;
    racer.hop = s.hop;
    racer.state = s.state;
    racer.riderPhase = s.riderPhase;
    racer.attackDir = s.attackDir;
    racer.attackTimer = s.attackTimer;
    racer.place = s.place;
    racer.finishTime = s.finishTime;
  }
}

export interface ReconcileOptions {
  /** Past this much disagreement in metres, stop blending and just snap. */
  snapMetres?: number;
  /** How fast the remaining error is closed, as a rate per second. */
  rate?: number;
}

/**
 * Fold the host's version of OUR OWN rider into the one we have been
 * predicting, without throwing the prediction away.
 *
 * A guest used to be a puppet: every rider on the grid, its own included, was
 * overwritten with the host's copy sixty times a second. That is why the
 * controls felt dead on a long link - a press could not move the bike, it
 * could only ask the host to move it, and the answer took a round trip to
 * arrive. Worse, when the host went quiet the last frame kept being reapplied,
 * which pinned the bike mid-road and looked exactly like a hung game.
 *
 * So the bike is now ridden locally and the host's copy is used to correct it:
 *
 *   - Anything the host alone can know - health, whether you are down, your
 *     place - is taken as given, always. Those are the outcomes of fights we
 *     did not simulate.
 *   - Position is *converged* on rather than assigned, so an ordinary
 *     disagreement of a metre or two washes out over a few frames instead of
 *     snatching the bike sideways every time a frame lands.
 *   - A big disagreement is a genuine desync, not lag, and snaps: being
 *     briefly teleported is better than spending ten seconds wrong.
 */
export function reconcileLocalRacer(
  racer: Racer,
  snapshot: RacerSnapshot,
  dt: number,
  options: ReconcileOptions = {},
): void {
  const { snapMetres = 6, rate = 6 } = options;

  // The host owns everything that is not our own motion.
  racer.health = snapshot.health;
  racer.place = snapshot.place;
  // Including when we crossed the line: our own clock is a prediction, and a
  // result board wants the time the race was actually run in.
  racer.finishTime = snapshot.finishTime;

  const wasRiding = racer.state === 'ride';
  racer.state = snapshot.state;
  racer.riderPhase = snapshot.riderPhase;

  // Off the bike there is nothing to predict: a crash, an arrest or a finish
  // is the host's verdict, and it has to land where the host says it did.
  if (snapshot.state !== 'ride' || !wasRiding) {
    racer.s = snapshot.s;
    racer.lateral = snapshot.lateral;
    racer.speed = snapshot.speed;
    racer.lean = snapshot.lean;
    racer.hop = snapshot.hop;
    racer.attackDir = snapshot.attackDir;
    racer.attackTimer = snapshot.attackTimer;
    return;
  }

  const error = Math.abs(snapshot.s - racer.s) + Math.abs(snapshot.lateral - racer.lateral);
  if (error > snapMetres) {
    racer.s = snapshot.s;
    racer.lateral = snapshot.lateral;
    racer.speed = snapshot.speed;
    return;
  }

  // Exponential convergence, framed per second so it behaves the same at 30fps
  // and at 120: a fixed per-frame fraction would correct twice as hard on a
  // fast phone as on a slow one.
  const k = 1 - Math.exp(-rate * Math.max(0, dt));
  racer.s += (snapshot.s - racer.s) * k;
  racer.lateral += (snapshot.lateral - racer.lateral) * k;
  racer.speed += (snapshot.speed - racer.speed) * k;
}

/** Blend two snapshots of the same grid. `t` is 0 at `from`, 1 at `to`. */
export function lerpRacers(
  from: readonly RacerSnapshot[],
  to: readonly RacerSnapshot[],
  t: number,
): RacerSnapshot[] {
  const k = Math.min(1, Math.max(0, t));
  const byId = new Map(to.map((s) => [s.id, s]));
  return from.map((a) => {
    const b = byId.get(a.id);
    if (!b) return a;
    return {
      ...a,
      s: a.s + (b.s - a.s) * k,
      lateral: a.lateral + (b.lateral - a.lateral) * k,
      speed: a.speed + (b.speed - a.speed) * k,
      lean: a.lean + (b.lean - a.lean) * k,
      health: a.health + (b.health - a.health) * k,
      hop: a.hop + (b.hop - a.hop) * k,
      // Discrete fields come from the frame we are leaving, not the one we are
      // heading for: better to show a crash a few milliseconds late than to
      // show a rider on the floor while their bike is still upright.
      state: a.state,
      riderPhase: a.riderPhase,
      attackDir: a.attackDir,
      // A swing that is already under way runs down smoothly; one that has
      // only just started belongs to the frame it started in.
      attackTimer: b.attackTimer > a.attackTimer
        ? a.attackTimer
        : a.attackTimer + (b.attackTimer - a.attackTimer) * k,
      place: a.place,
      finishTime: a.finishTime,
    };
  });
}

interface Held {
  message: StateMessage;
  /** performance.now() when this landed, in milliseconds. */
  localAtMs: number;
}

/**
 * Snapshots waiting to be drawn.
 *
 * Guests deliberately render slightly in the past. The host sends twenty
 * frames a second and the screen draws sixty, so two frames in three have no
 * snapshot of their own; holding a small delay means there is always a *later*
 * snapshot to interpolate towards, rather than having to guess forwards.
 */
export class SnapshotBuffer {
  private held: Held[] = [];
  private lastSeq = -1;
  private lastArrivalMs: number | null = null;
  /** Smoothed spread of arrival times, in seconds. */
  private arrivalJitter = 0;
  private adaptiveDelay: number;

  constructor(
    /**
     * The floor on how far behind the host we draw, in SECONDS, and the
     * starting point before anything has been measured.
     */
    private readonly delaySeconds = 0.1,
    private readonly keep = 12,
    /**
     * The ceiling. A link bad enough to want more than this is better served
     * by the guest predicting for itself than by burying the controls under a
     * third of a second of deliberate delay.
     */
    private readonly maxDelaySeconds = 0.35,
  ) {
    this.adaptiveDelay = delaySeconds;
  }

  get size(): number {
    return this.held.length;
  }

  /**
   * How far behind the host we are currently choosing to draw, in seconds.
   *
   * On a clean link this sits at the floor, which is the lowest delay that
   * still guarantees a frame to interpolate towards. On a link that arrives in
   * bursts it grows to cover the spread, because the alternative is running
   * out of frames and freezing every time one is late.
   */
  get delay(): number {
    return this.adaptiveDelay;
  }

  /** Milliseconds since the last frame landed. Infinity before the first. */
  ageMs(localNowMs: number): number {
    const newest = this.held.at(-1);
    if (!newest) return Infinity;
    return Math.max(0, localNowMs - newest.localAtMs);
  }

  /**
   * Throw away everything held, for a race that is not the one these frames
   * are about.
   *
   * The sequence number is deliberately kept: it belongs to the link, not to
   * the race, and forgetting it would let a frame that is genuinely stale be
   * accepted as new. What must go is the frames themselves - they carry the
   * previous race's clock, which reads minutes ahead of the one starting, and
   * a buffer is drained by comparing those clocks.
   */
  clear(): void {
    this.held = [];
    this.lastArrivalMs = null;
  }

  /** Take a frame. Out-of-order and duplicate frames are dropped. */
  push(message: StateMessage, localNowMs: number): void {
    if (message.seq <= this.lastSeq) return;
    this.lastSeq = message.seq;
    this.measureArrival(localNowMs);
    this.held.push({ message, localAtMs: localNowMs });
    if (this.held.length > this.keep) this.held.splice(0, this.held.length - this.keep);
  }

  /**
   * Size the delay from how unevenly frames are actually turning up.
   *
   * The host sends on a fixed timer, so every millisecond of unevenness here
   * was added by the network. Covering roughly two standard spreads keeps the
   * buffer fed through the ordinary wobble of a long-haul link without paying
   * for the worst case on a good one. It grows immediately and shrinks slowly,
   * because being late once is much worse than being 30ms further behind.
   */
  private measureArrival(localNowMs: number): void {
    const previous = this.lastArrivalMs;
    this.lastArrivalMs = localNowMs;
    if (previous === null) return;

    const gap = (localNowMs - previous) / 1000;
    const expected = 1 / SNAPSHOT_HZ;
    const deviation = Math.abs(gap - expected);
    this.arrivalJitter += (deviation - this.arrivalJitter) * 0.2;

    const wanted = Math.min(
      this.maxDelaySeconds,
      Math.max(this.delaySeconds, expected + this.arrivalJitter * 2),
    );
    this.adaptiveDelay += (wanted - this.adaptiveDelay) * (wanted > this.adaptiveDelay ? 0.5 : 0.05);
  }

  /**
   * Where the host's race clock has got to, in seconds, as best we can tell:
   * the newest frame's time plus however long ago it turned up. No round-trip clock sync - the
   * delay swallows the error, and being a few milliseconds out is invisible.
   */
  hostTime(localNowMs: number): number | null {
    const newest = this.held.at(-1);
    if (!newest) return null;
    // Local time is milliseconds (performance.now); race time is seconds.
    // Mixing the two silently put the render target minutes into the future.
    return newest.message.time + (localNowMs - newest.localAtMs) / 1000;
  }

  /** The grid as it should be drawn right now, or null if nothing has arrived. */
  sample(localNowMs: number): StateMessage | null {
    if (this.held.length === 0) return null;
    const newest = this.held.at(-1)!;
    if (this.held.length === 1) return newest.message;

    const target = (this.hostTime(localNowMs) ?? newest.message.time) - this.adaptiveDelay;

    const oldest = this.held[0]!;
    // Starved or stalled: hold the nearest frame rather than inventing motion.
    if (target <= oldest.message.time) return oldest.message;
    if (target >= newest.message.time) return newest.message;

    for (let i = this.held.length - 1; i > 0; i--) {
      const to = this.held[i]!.message;
      const from = this.held[i - 1]!.message;
      if (target >= from.time && target <= to.time) {
        const span = to.time - from.time;
        const k = span > 0 ? (target - from.time) / span : 1;
        return {
          ...to,
          racers: lerpRacers(from.racers, to.racers, k),
          cars: lerpCars(from.cars, to.cars, k),
          // People walk slowly enough that the newest frame will do;
          // interpolating them would only smear a launched body mid-flight.
          peds: to.peds,
        };
      }
    }
    return newest.message;
  }
}

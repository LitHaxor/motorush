// What actually travels over the data channel.
//
// Two messages, in opposite directions. The host sends snapshots of the world;
// guests send the inputs they are holding. The host is authoritative, so a
// guest's input is a request and a snapshot is the answer.
//
// JSON rather than a packed binary format: eight racers twenty times a second
// is about 2 KB/s, which is nothing over a direct link, and being able to read
// a frame in the console is worth more than the bytes saved.
//
// Nothing arriving here is trusted. It was produced by someone else's browser,
// so every field is checked and a malformed frame is dropped rather than
// thrown - a peer feeding us rubbish should cost a frame, not the race.

import type { RacerInput, RacerState, RaceState, RiderPhase } from '../sim/types';

/** Snapshots per second from the host. */
export const SNAPSHOT_HZ = 20;
/** Input frames per second from each guest. Cheap, so more often than snapshots. */
export const INPUT_HZ = 30;

const RACER_STATES: RacerState[] = ['ride', 'down', 'finished', 'busted'];
const RIDER_PHASES: RiderPhase[] = ['tumble', 'standing', 'running', 'lifting', 'mounting'];
const RACE_STATES: RaceState[] = ['countdown', 'racing', 'finished', 'busted', 'wasted'];

/**
 * One civilian car.
 *
 * Worth the bytes: the pool is only about a dozen cars, so the whole lot costs
 * roughly half what the riders do. Leaving traffic to each browser meant a
 * rival could clip a car you could not see.
 */
export interface CarSnapshot {
  id: number;
  s: number;
  lateral: number;
  speed: number;
  dir: 1 | -1;
  brake: number;
  swerve: number;
  color: number;
  /** CAR_TYPES key; only changes when the car recycles. */
  type: string;
}

/**
 * One pedestrian, as a tuple: [id, s, lateral, height, state].
 *
 * Tuples rather than objects because there are two dozen of them in shot and
 * the keys cost four times what the values do - 1.8KB a frame as objects
 * against 420 bytes like this. They matter because clipping one costs you
 * speed, so a guest has to be looking at the same people the host is.
 */
export type PedSnapshot = [number, number, number, number, number];

/** Wire order for pedestrian state; the index is what travels. */
export const PED_STATES = [
  'walking', 'waiting', 'cheering', 'strolling', 'flying', 'down',
] as const;
export type PedState = (typeof PED_STATES)[number];

/** Everything a guest needs to draw one rider it does not simulate. */
export interface RacerSnapshot {
  id: number;
  s: number;
  lateral: number;
  speed: number;
  lean: number;
  health: number;
  /** Height above the road - the hop from clipping somebody. */
  hop: number;
  state: RacerState;
  riderPhase: RiderPhase;
  attackDir: -1 | 0 | 1;
  place: number;
}

export interface StateMessage {
  t: 'state';
  /** Monotonic, so a frame that overtook a newer one can be discarded. */
  seq: number;
  /** Host's race clock in seconds, which is what guests interpolate against. */
  time: number;
  race: RaceState;
  countdown: number;
  racers: RacerSnapshot[];
  /**
   * Patrols, kept apart from the racers.
   *
   * They come and go mid-race and are not part of the eight-rider grid every
   * browser builds from the seed, so a guest has to be told they exist at all
   * - without this they simply could not see police.
   */
  cops: RacerSnapshot[];
  cars: CarSnapshot[];
  peds: PedSnapshot[];
}

export interface InputMessage {
  t: 'input';
  seq: number;
  input: RacerInput;
}

export type NetMessage = StateMessage | InputMessage;

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const bool = (v: unknown): boolean => v === true;

const clamp01 = (v: unknown): number => Math.min(1, Math.max(0, num(v)));

const oneOf = <T extends string>(v: unknown, allowed: T[], fallback: T): T =>
  typeof v === 'string' && (allowed as string[]).includes(v) ? (v as T) : fallback;

const dir = (v: unknown): -1 | 0 | 1 => (v === -1 || v === 1 ? v : 0);

export function encode(message: NetMessage): string {
  return JSON.stringify(message);
}

/** Parse a frame off the wire. Returns null for anything we cannot trust. */
export function decode(raw: string): NetMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;

  if (m.t === 'state') {
    if (!Array.isArray(m.racers)) return null;
    const racerList = (v: unknown): RacerSnapshot[] =>
      (Array.isArray(v) ? v : [])
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map((r) => ({
          id: num(r.id, -1),
          s: num(r.s),
          lateral: num(r.lateral),
          speed: num(r.speed),
          lean: num(r.lean),
          health: num(r.health),
          hop: num(r.hop),
          state: oneOf(r.state, RACER_STATES, 'ride'),
          riderPhase: oneOf(r.riderPhase, RIDER_PHASES, 'standing'),
          attackDir: dir(r.attackDir),
          place: num(r.place, 1),
        }))
        // A racer with no id cannot be matched to anything on the grid.
        .filter((r) => r.id >= 0);
    return {
      t: 'state',
      seq: num(m.seq),
      time: num(m.time),
      race: oneOf(m.race, RACE_STATES, 'racing'),
      countdown: num(m.countdown),
      racers: racerList(m.racers),
      cops: racerList(m.cops),
      cars: (Array.isArray(m.cars) ? m.cars : [])
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map((c) => ({
          id: num(c.id, -1),
          s: num(c.s),
          lateral: num(c.lateral),
          speed: num(c.speed),
          dir: c.dir === -1 ? (-1 as const) : (1 as const),
          brake: clamp01(c.brake),
          swerve: num(c.swerve),
          color: num(c.color),
          type: typeof c.type === 'string' ? c.type : '',
        }))
        .filter((c) => c.id >= 0),
      peds: (Array.isArray(m.peds) ? m.peds : [])
        .filter((v): v is unknown[] => Array.isArray(v) && v.length >= 5)
        .map((v) => [
          num(v[0], -1), num(v[1]), num(v[2]), num(v[3]),
          // Clamped to a real state so a bad index cannot crash the renderer.
          Math.min(PED_STATES.length - 1, Math.max(0, Math.round(num(v[4])))),
        ] as PedSnapshot)
        .filter((v) => v[0] >= 0),
    };
  }

  if (m.t === 'input') {
    const i = (typeof m.input === 'object' && m.input !== null ? m.input : {}) as Record<string, unknown>;
    return {
      t: 'input',
      seq: num(m.seq),
      input: {
        // Clamped, not just parsed: the sim trusts these to be in range, and
        // a throttle of 1e9 would otherwise be the cheapest cheat available.
        throttle: clamp01(i.throttle),
        brake: clamp01(i.brake),
        steer: Math.min(1, Math.max(-1, num(i.steer))),
        attackLeft: bool(i.attackLeft),
        attackRight: bool(i.attackRight),
      },
    };
  }

  return null;
}

// Tying the pieces together: a lobby, one link per rider, and the two streams
// that flow over them.
//
// The host simulates and broadcasts; guests send input and draw what comes
// back. The swap between a bot and a human is nothing more than whether an
// entry exists in the input map, so a rider arriving, dropping out or timing
// out all resolve to the same thing: the AI takes the bike back.

import type { Database } from 'firebase/database';
import type { RacerInput } from '../sim/types';
import {
  type LobbyHandle, type RoomState, type Seat,
  createRoom, joinByCode, joinOrHost, leave, randomSeed, resetRace, setOpen, startRace, watchRoom,
} from './lobby';
import { type PeerLink, openPeerLink } from './peer';
import { INPUT_HZ, SNAPSHOT_HZ, type StateMessage, decode, encode } from './protocol';
import { LinkHealth, type LinkQuality } from './health';
import { SnapshotBuffer, captureCars, capturePeds, captureRacers } from './snapshot';
import type { Pedestrian } from '../sim/pedestrians';
import type { Car, Racer } from '../sim/types';
import type { NetSession } from './session';

/**
 * How long a rider's last input stays good for.
 *
 * A link can stay nominally open while nothing comes down it - a tab in the
 * background, a phone that lost signal. Rather than leave that rider coasting
 * in a straight line, their input goes stale and the AI picks the bike up.
 */
const INPUT_TTL_MS = 1000;

/** Punches held for a host that is not currently draining them. */
const MAX_HELD_ATTACKS = 16;

/**
 * Which seats a human is currently riding, and what they are holding.
 *
 * Keyed by Racer.id, which is the seat index - so this map is exactly what
 * World.step wants for its `remoteInputs` argument.
 */
export class RemoteInputTracker {
  private readonly held = new Map<number, { input: RacerInput; atMs: number }>();

  constructor(private readonly ttlMs = INPUT_TTL_MS) {}

  set(racerId: number, input: RacerInput, nowMs: number): void {
    this.held.set(racerId, { input, atMs: nowMs });
  }

  /** A rider left, or their link closed. The AI has the bike back next tick. */
  drop(racerId: number): void {
    this.held.delete(racerId);
  }

  clear(): void {
    this.held.clear();
  }

  /** Everything still fresh enough to drive a bike. */
  current(nowMs: number): ReadonlyMap<number, Readonly<RacerInput>> {
    const out = new Map<number, Readonly<RacerInput>>();
    for (const [id, entry] of this.held) {
      if (nowMs - entry.atMs <= this.ttlMs) out.set(id, entry.input);
    }
    return out;
  }

  /** Seats whose rider has gone quiet, for dropping and for the HUD. */
  stale(nowMs: number): number[] {
    return [...this.held]
      .filter(([, e]) => nowMs - e.atMs > this.ttlMs)
      .map(([id]) => id);
  }
}

/** Fires at most `hz` times a second. */
export class Ticker {
  private nextAtMs = 0;
  constructor(private readonly intervalMs: number) {}
  static atHz(hz: number): Ticker {
    return new Ticker(1000 / hz);
  }
  due(nowMs: number): boolean {
    if (nowMs < this.nextAtMs) return false;
    // Anchor to now rather than to the missed slot, so a stalled tab does not
    // come back and fire a burst of catch-up frames.
    this.nextAtMs = nowMs + this.intervalMs;
    return true;
  }
}

/** Everything the host puts on the wire each tick. */
export interface BroadcastSource {
  racers: readonly Racer[];
  /** Patrols currently on the road; empty most of the time. */
  cops: readonly Racer[];
  cars: readonly Car[];
  peds: readonly Pedestrian[];
  /** Where to centre the pedestrian cull - the host's own rider. */
  aroundS: number;
  time: number;
  /** How the race as a whole is going, never how the host's own race is going. */
  phase: StateMessage['phase'];
  countdown: number;
}

export interface OnlineRace {
  readonly lobbyId: string;
  /**
   * The track everyone builds. Read from the room rather than remembered from
   * when we joined, because a rematch rolls a new one.
   */
  readonly seed: number;
  /** Our seat, which is the Racer.id we drive. */
  readonly seat: number;
  readonly isHost: boolean;
  /** What you read out to a friend so they can join. */
  readonly code: string;
  /** Whoever opened the room, and the only one who can start it. */
  readonly hostUid: string;
  /** Riders on the grid right now, including us. */
  seats(): readonly Seat[];
  /** True once the flag has dropped. Guests wait for this. */
  started(): boolean;
  /**
   * Which race is under way, as the server timestamped its start - or null
   * while the room is waiting. It changes when the host runs it again, which
   * is how a rider tells a rematch from the race they have just ridden.
   */
  startedAt(): number | null;
  /** Host only: drop the flag. Everyone watching sets off together. */
  start(): Promise<void>;
  /**
   * Host only: take the room out of the race and back to the lobby, on a new
   * seed, so it can go again.
   */
  rematch(): Promise<void>;
  /** Called whenever the room changes, for the lobby screen. Null means it is gone. */
  onRoom(handle: (room: RoomState | null) => void): void;
  /** Host only: what the humans are holding, for World.step. */
  inputs(nowMs: number): ReadonlyMap<number, Readonly<RacerInput>>;
  /** Host only: push the world out. Rate-limits itself; call it every frame. */
  broadcast(snapshot: BroadcastSource, nowMs: number): void;
  /**
   * Guest only: send what we are holding. Rate-limits itself.
   *
   * Returns whether the frame actually went, because a punch is a one-shot
   * event riding along with it - the caller has to know whether to keep
   * holding onto it or let it go.
   */
  sendInput(input: RacerInput, nowMs: number): boolean;
  /** Guest only: the grid as it should be drawn. */
  sample(nowMs: number): StateMessage | null;
  /** Guest only: snapshots held for interpolation. Zero means nothing is arriving. */
  buffered(): number;
  /**
   * Guest only: forget everything buffered, because a new race is starting.
   *
   * Frames in flight when the flag drops are about the race before it, on a
   * clock that is minutes ahead of the one beginning - drawn onto the new
   * world they put the grid somewhere nobody is.
   */
  resetStream(): void;
  /**
   * Keepalive. Call every frame, racing or not: it is what measures the round
   * trip and what notices a link that has quietly stopped carrying anything.
   */
  tick(nowMs: number): void;
  /** Smoothed round trip to the host, or to the slowest guest. Null until measured. */
  ping(nowMs: number): number | null;
  /** One word for the state of the link this browser depends on. */
  quality(nowMs: number): LinkQuality;
  /** Guest only: how long since a snapshot landed. Infinity before the first. */
  snapshotAgeMs(nowMs: number): number;
  /**
   * Host only: punches thrown by remote riders since the last call.
   *
   * Drained rather than held, because a swing is an event and the input map is
   * a level - leaving the flag set would have the host swinging again every
   * time the cooldown expired, off one press.
   */
  attacks(): Array<{ id: number; dir: -1 | 1 }>;
  /**
   * Host only: stop accepting new riders.
   *
   * Called when the lights go out. Without it a lobby stays open for ever and
   * matchmaking keeps sending riders into a race that is already half run,
   * where they would appear at the start line behind the entire field.
   */
  closeLobby(): Promise<void>;
  close(): Promise<void>;
}

/** Which front door the player came through. */
export type JoinMode =
  /** Matched into any public room with a seat free, opening one if needed. */
  | { kind: 'quick' }
  /** A private room of our own; only reachable by its code. */
  | { kind: 'create' }
  /** Somebody read us a code. */
  | { kind: 'code'; code: string };

export interface GoOnlineOptions {
  mode?: JoinMode;
  /** Injected so the whole orchestrator is testable without a browser. */
  openLink?: typeof openPeerLink;
}

/**
 * Take a seat and wire up whatever links that implies.
 *
 * Returns null only if the lobby itself could not be reached. Failing to
 * connect to any individual rider is not a failure - that seat stays a bot.
 */
export async function goOnline(
  session: NetSession,
  riderName: string,
  options: GoOnlineOptions = {},
): Promise<OnlineRace | null> {
  const { db, uid } = session;
  const openLink = options.openLink ?? openPeerLink;

  const mode = options.mode ?? { kind: 'quick' };

  let handle: LobbyHandle | null;
  try {
    if (mode.kind === 'create') handle = await createRoom(db, uid, riderName);
    else if (mode.kind === 'code') handle = await joinByCode(db, uid, riderName, mode.code);
    else handle = await joinOrHost(db, uid, riderName);
  } catch {
    return null;
  }
  // A bad code is a real answer the player needs told apart from "it worked",
  // so unlike Quick Match this does not quietly open a room instead.
  if (!handle) return null;

  const links = new Map<string, PeerLink>();
  const seatOfUid = new Map<string, number>();
  const tracker = new RemoteInputTracker();
  const buffer = new SnapshotBuffer(2 / SNAPSHOT_HZ);
  const snapshotTicker = Ticker.atHz(SNAPSHOT_HZ);
  const inputTicker = Ticker.atHz(INPUT_HZ);
  const health = new Map<string, LinkHealth>();
  const pendingAttacks: Array<{ id: number; dir: -1 | 1 }> = [];
  let seats: Seat[] = [];
  let seq = 0;
  let lobbyClosed = false;
  let hasStarted = false;
  let startedAt: number | null = null;
  // The seed the room is on right now. A rematch writes a new one, and every
  // rider picks it up here rather than from the handle they joined with.
  let currentSeed = handle.seed;
  let onRoomHandler: ((room: RoomState | null) => void) | null = null;

  const linkTo = (peerUid: string, offerer: boolean): PeerLink => {
    const link = openLink({ db, lobbyId: handle.id, selfUid: uid, peerUid, offerer });
    const state = new LinkHealth();
    health.set(peerUid, state);
    link.onMessage((raw) => {
      const at = now();
      const message = decode(raw);
      if (!message) return;
      // Anything at all is proof of life, and a snapshot is far better
      // evidence than a pong because there are twenty a second of them.
      state.heard(at);

      if (message.t === 'ping') {
        // Answered the instant it lands, and both of our timestamps ride back
        // so the far end can subtract our handling out of its measurement.
        link.send(encode({ t: 'pong', id: message.id, recv: at, send: now() }));
        return;
      }
      if (message.t === 'pong') {
        state.onPong(message.id, message.recv, message.send, at);
        return;
      }
      if (message.t === 'input' && handle.isHost) {
        const seat = seatOfUid.get(peerUid);
        if (seat === undefined) return;
        tracker.set(seat, message.input, at);
        // A punch is an event, not a held key. Queue it once, here, where
        // each input frame is seen exactly once.
        if (message.input.attackLeft) pendingAttacks.push({ id: seat, dir: -1 });
        if (message.input.attackRight) pendingAttacks.push({ id: seat, dir: 1 });
        // Drained every frame by a racing host. If nothing is draining them -
        // the host is between races, say - they must not pile up into a
        // flurry that all lands at once when one does.
        if (pendingAttacks.length > MAX_HELD_ATTACKS) {
          pendingAttacks.splice(0, pendingAttacks.length - MAX_HELD_ATTACKS);
        }
        return;
      }
      if (message.t === 'state' && !handle.isHost) {
        buffer.push(message, at);
      }
    });
    link.onStateChange((next) => {
      if (next === 'closed' || next === 'failed') {
        const seat = seatOfUid.get(peerUid);
        // Their bike does not stop; the AI simply takes it over.
        if (seat !== undefined) tracker.drop(seat);
        // Measurements from a dead link would otherwise sit on the HUD
        // looking healthy for as long as the room stays open.
        state.reset();
      }
    });
    return link;
  };

  const room = handle;
  const stopWatching = watchRoom(db, room.id, (state) => {
    if (!state) {
      // The host closed the tab and took the room with them.
      onRoomHandler?.(null);
      return;
    }
    hasStarted = state.started;
    startedAt = state.startedAt;
    if (typeof state.seed === 'number' && Number.isFinite(state.seed)) currentSeed = state.seed;
    const next = state.seats;
    seats = next;
    onRoomHandler?.(state);
    for (const s of next) seatOfUid.set(s.uid, s.slot);

    if (handle.isHost) {
      // The host offers to everyone who sits down.
      for (const s of next) {
        if (s.uid !== uid && !links.has(s.uid)) links.set(s.uid, linkTo(s.uid, true));
      }
      // And forgets anyone who got up.
      const present = new Set(next.map((s) => s.uid));
      for (const [peerUid, link] of links) {
        if (!present.has(peerUid)) {
          link.close();
          links.delete(peerUid);
          const seat = seatOfUid.get(peerUid);
          if (seat !== undefined) tracker.drop(seat);
        }
      }
    } else if (!links.has(handle.host)) {
      // A guest holds exactly one link, to the host, and answers rather than
      // offers. Opened while still in the lobby, so the handshake is long done
      // by the time the flag drops.
      links.set(handle.host, linkTo(handle.host, false));
    }
  });

  return {
    lobbyId: handle.id,
    get seed() {
      return currentSeed;
    },
    seat: handle.slot,
    isHost: handle.isHost,

    code: handle.code,
    hostUid: handle.host,

    seats: () => seats,

    started: () => hasStarted,

    startedAt: () => startedAt,

    async start() {
      if (!handle.isHost) return;
      await startRace(db, handle).catch(() => {});
    },

    async rematch() {
      if (!handle.isHost) return;
      // Deliberately not reopened to matchmaking: a room that has raced once
      // belongs to the people in it, and anybody they read the code to can
      // still walk in now that the flag is down.
      await resetRace(db, handle, randomSeed()).catch(() => {});
    },

    onRoom(h) {
      onRoomHandler = h;
    },

    inputs(nowMs) {
      for (const id of tracker.stale(nowMs)) tracker.drop(id);
      return tracker.current(nowMs);
    },

    broadcast(source, nowMs) {
      if (!handle.isHost || links.size === 0) return;
      if (!snapshotTicker.due(nowMs)) return;
      const frame = encode({
        t: 'state',
        seq: ++seq,
        time: source.time,
        phase: source.phase,
        countdown: source.countdown,
        racers: captureRacers(source.racers),
        cops: captureRacers(source.cops),
        cars: captureCars(source.cars),
        peds: capturePeds(source.peds, source.aroundS),
      });
      for (const link of links.values()) link.send(frame);
    },

    sendInput(input, nowMs) {
      if (handle.isHost) return false;
      if (!inputTicker.due(nowMs)) return false;
      const link = links.get(handle.host);
      if (!link) return false;
      link.send(encode({ t: 'input', seq: ++seq, input }));
      return true;
    },

    sample: (nowMs) => (handle.isHost ? null : buffer.sample(nowMs)),

    buffered: () => (handle.isHost ? 0 : buffer.size),

    resetStream: () => buffer.clear(),

    tick(nowMs) {
      // Both ends ping, so both ends have their own measurement rather than
      // one side having to be told what the other thinks.
      for (const [peerUid, link] of links) {
        const state = health.get(peerUid);
        if (!state) continue;
        const id = state.pingDue(nowMs);
        if (id !== null) link.send(encode({ t: 'ping', id, at: nowMs }));
      }
    },

    ping(nowMs) {
      if (!handle.isHost) return health.get(handle.host)?.rttMs ?? null;
      // The host is only as good as its worst rider, which is the number
      // worth showing: it is the one that decides whether anyone is suffering.
      let worst: number | null = null;
      for (const state of health.values()) {
        if (state.quality(nowMs) === 'lost') continue;
        const rtt = state.rttMs;
        if (rtt !== null && (worst === null || rtt > worst)) worst = rtt;
      }
      return worst;
    },

    quality(nowMs) {
      if (!handle.isHost) {
        const state = health.get(handle.host);
        if (!state) return 'lost';
        // A link still carrying snapshots is working, whatever the pongs say:
        // a dropped heartbeat matters far less than a stream that stopped.
        if (buffer.ageMs(nowMs) < 500) {
          const q = state.quality(nowMs);
          return q === 'lost' ? 'poor' : q;
        }
        return state.quality(nowMs);
      }
      // A host never depends on anyone, so its own race is never at risk -
      // report the worst rider so the HUD can say who is struggling.
      let worst: LinkQuality = 'good';
      const rank: Record<LinkQuality, number> = { good: 0, fair: 1, poor: 2, lost: 3 };
      for (const state of health.values()) {
        const q = state.quality(nowMs);
        if (rank[q] > rank[worst]) worst = q;
      }
      return links.size === 0 ? 'good' : worst;
    },

    snapshotAgeMs: (nowMs) => (handle.isHost ? 0 : buffer.ageMs(nowMs)),

    attacks() {
      if (!handle.isHost || pendingAttacks.length === 0) return [];
      return pendingAttacks.splice(0, pendingAttacks.length);
    },

    async closeLobby() {
      if (!handle.isHost || lobbyClosed) return;
      lobbyClosed = true;
      await setOpen(db, handle, false).catch(() => {});
    },

    async close() {
      stopWatching();
      for (const link of links.values()) link.close();
      links.clear();
      health.clear();
      pendingAttacks.length = 0;
      tracker.clear();
      await leave(db, handle).catch(() => {});
    },
  };
}

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

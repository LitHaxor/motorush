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
  createRoom, joinByCode, joinOrHost, leave, setOpen, startRace, watchRoom,
} from './lobby';
import { type PeerLink, openPeerLink } from './peer';
import { INPUT_HZ, SNAPSHOT_HZ, type StateMessage, decode, encode } from './protocol';
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
  cars: readonly Car[];
  peds: readonly Pedestrian[];
  /** Where to centre the pedestrian cull - the host's own rider. */
  aroundS: number;
  time: number;
  race: StateMessage['race'];
  countdown: number;
}

export interface OnlineRace {
  readonly lobbyId: string;
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
  /** Host only: drop the flag. Everyone watching sets off together. */
  start(): Promise<void>;
  /** Called whenever the room changes, for the lobby screen. Null means it is gone. */
  onRoom(handle: (room: RoomState | null) => void): void;
  /** Host only: what the humans are holding, for World.step. */
  inputs(nowMs: number): ReadonlyMap<number, Readonly<RacerInput>>;
  /** Host only: push the world out. Rate-limits itself; call it every frame. */
  broadcast(snapshot: BroadcastSource, nowMs: number): void;
  /** Guest only: send what we are holding. Rate-limits itself. */
  sendInput(input: RacerInput, nowMs: number): void;
  /** Guest only: the grid as it should be drawn. */
  sample(nowMs: number): StateMessage | null;
  /** Guest only: snapshots held for interpolation. Zero means nothing is arriving. */
  buffered(): number;
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
  let seats: Seat[] = [];
  let seq = 0;
  let lobbyClosed = false;
  let hasStarted = false;
  let onRoomHandler: ((room: RoomState | null) => void) | null = null;

  const linkTo = (peerUid: string, offerer: boolean): PeerLink => {
    const link = openLink({ db, lobbyId: handle.id, selfUid: uid, peerUid, offerer });
    link.onMessage((raw) => {
      const message = decode(raw);
      if (!message) return;
      if (message.t === 'input' && handle.isHost) {
        const seat = seatOfUid.get(peerUid);
        if (seat !== undefined) tracker.set(seat, message.input, now());
      } else if (message.t === 'state' && !handle.isHost) {
        buffer.push(message, now());
      }
    });
    link.onStateChange((state) => {
      if (state === 'closed' || state === 'failed') {
        const seat = seatOfUid.get(peerUid);
        // Their bike does not stop; the AI simply takes it over.
        if (seat !== undefined) tracker.drop(seat);
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
    seed: handle.seed,
    seat: handle.slot,
    isHost: handle.isHost,

    code: handle.code,
    hostUid: handle.host,

    seats: () => seats,

    started: () => hasStarted,

    async start() {
      if (!handle.isHost) return;
      await startRace(db, handle).catch(() => {});
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
        race: source.race,
        countdown: source.countdown,
        racers: captureRacers(source.racers),
        cars: captureCars(source.cars),
        peds: capturePeds(source.peds, source.aroundS),
      });
      for (const link of links.values()) link.send(frame);
    },

    sendInput(input, nowMs) {
      if (handle.isHost) return;
      if (!inputTicker.due(nowMs)) return;
      links.get(handle.host)?.send(encode({ t: 'input', seq: ++seq, input }));
    },

    sample: (nowMs) => (handle.isHost ? null : buffer.sample(nowMs)),

    buffered: () => (handle.isHost ? 0 : buffer.size),

    async closeLobby() {
      if (!handle.isHost || lobbyClosed) return;
      lobbyClosed = true;
      await setOpen(db, handle, false).catch(() => {});
    },

    async close() {
      stopWatching();
      for (const link of links.values()) link.close();
      links.clear();
      tracker.clear();
      await leave(db, handle).catch(() => {});
    },
  };
}

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

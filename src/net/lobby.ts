// Rooms over the Realtime Database.
//
// Two ways in. Quick Match drops you into any public room with a seat free,
// opening one if there isn't. A custom room is private - it never shows up in
// matchmaking - and is joined by typing its four-letter code.
//
// Either way you land in a room and wait. The owner starts the race when they
// are ready; whatever seats are still empty at that moment are ridden by bots,
// so a room never needs filling before it can race.
//
// Every function here takes the Database rather than reaching for a global,
// so the whole module runs against the emulator in tests.

import {
  type Database,
  type DataSnapshot,
  equalTo,
  get,
  limitToFirst,
  onDisconnect,
  onValue,
  orderByChild,
  push,
  query,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
} from 'firebase/database';

/** Seats on the grid. Index doubles as the Racer.id it drives. */
export const GRID_SLOTS = 8;
/**
 * Riders fill the grid from the back.
 *
 * The first person in takes the last seat, the second takes the one in front
 * of them, and so on - so a room of humans always starts as a block at the
 * rear and has to carve through the bots to win, rather than being handed the
 * front row for turning up early.
 */
export const FIRST_SEAT = GRID_SLOTS - 1;
/** How many open rooms to consider before giving up and hosting. */
const SEARCH_LIMIT = 5;

/**
 * Room code alphabet.
 *
 * No O/0, I/1 or S/5 - these get read aloud and typed in by hand, and a code
 * nobody can dictate over a voice call is not much of a code.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
export const CODE_LENGTH = 4;

/** A short, human-typeable room code. */
export function makeRoomCode(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  }
  return out;
}

/** Tidy whatever the player typed into something we can look up. */
export function normaliseRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

export interface Seat {
  slot: number;
  uid: string;
  name: string;
}

export interface LobbyHandle {
  id: string;
  seed: number;
  host: string;
  /** The seat we hold, which is the Racer.id we drive. */
  slot: number;
  isHost: boolean;
  /** What you read out to a friend so they can join. */
  code: string;
}

export interface LobbyRecord {
  host: string;
  seed: number;
  /** Listed in Quick Match. A custom room is never open. */
  open: boolean;
  code: string;
  /** Host's clock when the race began; absent while still waiting. */
  startedAt?: number | null;
  slots?: Record<string, { uid: string; name: string }>;
}

/** A room as the lobby screen needs to draw it. */
export interface RoomState {
  code: string;
  seats: Seat[];
  /** Set once the race is under way. */
  started: boolean;
  hostUid: string;
}

const lobbyPath = (id: string) => `lobbies/${id}`;
const seatPath = (id: string, slot: number) => `lobbies/${id}/slots/${slot}`;

/** A seed both ends can rebuild the identical track from. */
export function randomSeed(rand: () => number = Math.random): number {
  return Math.floor(rand() * 0x7fffffff);
}

/** Seats currently taken, lowest first. */
export function readSeats(record: LobbyRecord | null): Seat[] {
  if (!record?.slots) return [];
  return Object.entries(record.slots)
    .map(([slot, v]) => ({ slot: Number(slot), uid: v.uid, name: v.name }))
    .filter((s) => Number.isInteger(s.slot) && s.slot >= 0 && s.slot < GRID_SLOTS)
    .sort((a, b) => a.slot - b.slot);
}

/** Free seats, back of the grid first, so riders pack in from the rear. */
export function freeSeats(record: LobbyRecord | null): number[] {
  const taken = new Set(readSeats(record).map((s) => s.slot));
  const out: number[] = [];
  for (let i = FIRST_SEAT; i >= 0; i--) if (!taken.has(i)) out.push(i);
  return out;
}

/**
 * Claim one seat. Returns true only if we ended up in it.
 *
 * A transaction rather than a plain set: two riders can reach for the same
 * seat in the same instant, and this way the loser finds out by being told
 * the seat was taken rather than by a permission error.
 */
async function claimSeat(
  db: Database,
  lobbyId: string,
  slot: number,
  uid: string,
  name: string,
): Promise<boolean> {
  const seat = ref(db, seatPath(lobbyId, slot));
  try {
    const res = await runTransaction(seat, (current) =>
      current === null ? { uid, name } : undefined,
    );
    return res.committed && res.snapshot.child('uid').val() === uid;
  } catch {
    // The rules refuse a seat that filled between read and write.
    return false;
  }
}

/**
 * Open a room of our own and take seat 0.
 *
 * `listed` is what separates the two front doors: a Quick Match room is
 * listed and anyone can be matched into it, a custom room is not and can only
 * be reached by typing its code.
 */
export async function hostLobby(
  db: Database,
  uid: string,
  name: string,
  seed: number,
  listed = true,
  rand: () => number = Math.random,
): Promise<LobbyHandle> {
  const created = push(ref(db, 'lobbies'));
  const id = created.key!;
  const code = makeRoomCode(rand);

  // A plain set, not a transaction: push() just minted this key so nothing can
  // be contending for it, and serverTimestamp() sentinels do not survive a
  // transaction's optimistic local apply cleanly.
  await set(created, {
    host: uid,
    seed,
    createdAt: serverTimestamp(),
    open: listed,
    code,
  });

  // Close the tab and the lobby goes with it, rather than lingering as a
  // ghost that other riders keep trying to join. This is the single reason
  // this game is on the Realtime Database and not Firestore.
  await onDisconnect(ref(db, lobbyPath(id))).remove();

  await claimSeat(db, id, FIRST_SEAT, uid, name);
  return { id, seed, host: uid, slot: FIRST_SEAT, isHost: true, code };
}

/**
 * Join the room with this code.
 *
 * Returns null when there is no such room, when it is full, or when the race
 * has already started - all of which the player needs told apart from "it
 * worked", so this never silently opens a room of its own the way Quick Match
 * does.
 */
export async function joinByCode(
  db: Database,
  uid: string,
  name: string,
  rawCode: string,
): Promise<LobbyHandle | null> {
  const code = normaliseRoomCode(rawCode);
  if (code.length !== CODE_LENGTH) return null;

  let found: DataSnapshot;
  try {
    found = await get(query(ref(db, 'lobbies'), orderByChild('code'), equalTo(code)));
  } catch {
    return null;
  }

  const rooms: Array<{ id: string; record: LobbyRecord }> = [];
  found.forEach((child) => {
    const record = child.val() as LobbyRecord | null;
    if (record && child.key) rooms.push({ id: child.key, record });
  });

  for (const { id, record } of rooms) {
    if (record.startedAt) continue; // already racing
    for (const slot of freeSeats(record)) {
      if (await claimSeat(db, id, slot, uid, name)) {
        await onDisconnect(ref(db, seatPath(id, slot))).remove();
        return { id, seed: record.seed, host: record.host, slot, isHost: false, code };
      }
    }
  }
  return null;
}

/** Open a private room nobody will be matched into. */
export function createRoom(
  db: Database,
  uid: string,
  name: string,
  opts: { seed?: number; rand?: () => number } = {},
): Promise<LobbyHandle> {
  const rand = opts.rand ?? Math.random;
  return hostLobby(db, uid, name, opts.seed ?? randomSeed(rand), false, rand);
}

/**
 * Find a lobby with room and sit down, or open one.
 *
 * Never rejects for "no lobbies": hosting is the fallback, and a host with no
 * guests is a perfectly good single-player race against bots.
 */
export async function joinOrHost(
  db: Database,
  uid: string,
  name: string,
  opts: { seed?: number; rand?: () => number } = {},
): Promise<LobbyHandle> {
  const rand = opts.rand ?? Math.random;

  let open: DataSnapshot;
  try {
    open = await get(
      query(ref(db, 'lobbies'), orderByChild('open'), equalTo(true), limitToFirst(SEARCH_LIMIT)),
    );
  } catch {
    // Can't see the list - host rather than refuse to play.
    return hostLobby(db, uid, name, opts.seed ?? randomSeed(rand));
  }

  const candidates: Array<{ id: string; record: LobbyRecord }> = [];
  open.forEach((child) => {
    const record = child.val() as LobbyRecord | null;
    // Never our own room, and never one that is already under way - a rider
    // dropped into a running race has no lobby to wait in.
    if (record && child.key && record.host !== uid && !record.startedAt) {
      candidates.push({ id: child.key, record });
    }
  });

  for (const { id, record } of candidates) {
    for (const slot of freeSeats(record)) {
      if (await claimSeat(db, id, slot, uid, name)) {
        await onDisconnect(ref(db, seatPath(id, slot))).remove();
        return {
          id, seed: record.seed, host: record.host, slot, isHost: false,
          code: record.code ?? '',
        };
      }
      // Somebody beat us to it; try the next seat, then the next lobby.
    }
  }

  return hostLobby(db, uid, name, opts.seed ?? randomSeed(rand));
}

/**
 * Open or close the lobby to new riders. Host only - the rules refuse anyone
 * else writing the lobby root.
 */
export async function setOpen(
  db: Database,
  handle: LobbyHandle,
  open: boolean,
): Promise<void> {
  if (!handle.isHost) return;
  await set(ref(db, `${lobbyPath(handle.id)}/open`), open);
}

/** Give up our seat, or the whole lobby if we were hosting it. */
export async function leave(db: Database, handle: LobbyHandle): Promise<void> {
  const target = handle.isHost
    ? ref(db, lobbyPath(handle.id))
    : ref(db, seatPath(handle.id, handle.slot));
  // Cancel the disconnect hook first: leaving deliberately and dropping off
  // the network should not both fire.
  await onDisconnect(target).cancel().catch(() => {});
  await remove(target);
}

/**
 * Host drops the flag. Everyone watching the room sees it and sets off
 * together, which is what keeps the grid in step.
 */
export async function startRace(db: Database, handle: LobbyHandle): Promise<void> {
  if (!handle.isHost) return;
  await set(ref(db, `${lobbyPath(handle.id)}/startedAt`), serverTimestamp());
}

/** Watch the whole room: who is on the grid, and whether it has set off. */
export function watchRoom(
  db: Database,
  lobbyId: string,
  onChange: (room: RoomState | null) => void,
): () => void {
  return onValue(ref(db, lobbyPath(lobbyId)), (snap) => {
    const record = snap.val() as LobbyRecord | null;
    if (!record) {
      // The host closed the tab and took the room with them.
      onChange(null);
      return;
    }
    onChange({
      code: record.code ?? '',
      seats: readSeats(record),
      started: Boolean(record.startedAt),
      hostUid: record.host,
    });
  });
}



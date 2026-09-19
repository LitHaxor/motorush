import { readFileSync } from 'node:fs';
import { type Database, get, ref } from 'firebase/database';
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CODE_LENGTH,
  GRID_SLOTS,
  FIRST_SEAT,
  createRoom,
  freeSeats,
  joinByCode,
  joinOrHost,
  leave,
  randomSeed,
  readSeats,
  startRace,
  watchRoom,
} from '../../src/net/lobby';

let env: RulesTestEnvironment;

/** Poll until it holds, rather than sleeping and hoping. */
async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition never held');
}

// rules-unit-testing hands back the *compat* Database type. It is the same
// object at runtime - these tests pass against it - but the modular typings
// carry a brand the compat ones lack, so the two are not assignable. Cast in
// these two helpers rather than at every call site.
const asModular = (db: unknown) => db as Database;

/** A signed-in rider's view of the database, exactly as the game would hold it. */
const rider = (uid: string): Database => asModular(env.authenticatedContext(uid).database());

/** Straight past the rules, for asserting on what actually landed. */
async function raw<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  let out!: T;
  await env.withSecurityRulesDisabled(async (ctx) => {
    out = await fn(asModular(ctx.database()));
  });
  return out;
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-motorush',
    database: {
      rules: readFileSync('database.rules.json', 'utf8'),
      host: '127.0.0.1',
      port: 9000,
    },
  });
});

afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearDatabase(); });

describe('seat arithmetic', () => {
  const record = (slots: Record<string, { uid: string; name: string }>) =>
    ({ host: 'h', seed: 1, open: true, code: 'AB23', slots });

  it('reads seats in grid order', () => {
    const seats = readSeats(record({
      3: { uid: 'c', name: 'C' },
      0: { uid: 'a', name: 'A' },
    }));
    expect(seats.map((s) => s.slot)).toEqual([0, 3]);
  });

  it('treats an empty lobby as an empty grid', () => {
    expect(readSeats(null)).toEqual([]);
    expect(readSeats({ host: 'h', seed: 1, open: true, code: 'AB23' })).toEqual([]);
  });

  it('discards seats outside the grid', () => {
    const seats = readSeats(record({ 99: { uid: 'x', name: 'X' } }));
    expect(seats).toEqual([]);
  });

  it('offers the back of the grid first', () => {
    // Riders pack in from the rear so a room of humans has to carve through
    // the bots rather than being handed the front row for turning up early.
    expect(freeSeats(null)[0]).toBe(FIRST_SEAT);
    expect(freeSeats(null)).toHaveLength(GRID_SLOTS);
  });

  it('offers only what is actually free', () => {
    expect(freeSeats(record({ 7: { uid: 'h', name: 'H' }, 6: { uid: 'b', name: 'B' } })))
      .toEqual([5, 4, 3, 2, 1, 0]);
  });

  it('produces a seed that survives the wire as a plain number', () => {
    const seed = randomSeed(() => 0.5);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
  });
});

describe('joining or hosting', () => {
  it('hosts when there is nothing to join, and takes the back of the grid', async () => {
    const h = await joinOrHost(rider('alice'), 'alice', 'ALICE');
    expect(h.isHost).toBe(true);
    expect(h.slot).toBe(FIRST_SEAT);
    expect(h.host).toBe('alice');

    const snap = await raw((db) => get(ref(db, `lobbies/${h.id}`)));
    expect(snap.val().open).toBe(true);
    expect(snap.val().slots[String(FIRST_SEAT)]).toEqual({ uid: 'alice', name: 'ALICE' });
  });

  it('puts the second rider in the first host’s lobby', async () => {
    const host = await joinOrHost(rider('alice'), 'alice', 'ALICE');
    const guest = await joinOrHost(rider('bob'), 'bob', 'BOB');

    expect(guest.isHost).toBe(false);
    expect(guest.id).toBe(host.id);
    expect(guest.slot).toBe(FIRST_SEAT - 1);
    // Both ends must rebuild the same track.
    expect(guest.seed).toBe(host.seed);
  });

  it('fills the grid one seat at a time', async () => {
    const host = await joinOrHost(rider('alice'), 'alice', 'ALICE');
    const slots: number[] = [];
    for (let i = 1; i < GRID_SLOTS; i++) {
      slots.push((await joinOrHost(rider(`r${i}`), `r${i}`, `R${i}`)).slot);
    }
    expect(slots).toEqual([6, 5, 4, 3, 2, 1, 0]);

    const snap = await raw((db) => get(ref(db, `lobbies/${host.id}/slots`)));
    expect(Object.keys(snap.val())).toHaveLength(GRID_SLOTS);
  });

  it('opens a second lobby once the grid is full rather than turning anyone away', async () => {
    const first = await joinOrHost(rider('alice'), 'alice', 'ALICE');
    for (let i = 1; i < GRID_SLOTS; i++) await joinOrHost(rider(`r${i}`), `r${i}`, `R${i}`);

    const overflow = await joinOrHost(rider('late'), 'late', 'LATE');
    expect(overflow.id).not.toBe(first.id);
    expect(overflow.isHost).toBe(true);
    expect(overflow.slot).toBe(FIRST_SEAT);
  });

  it('never rejoins its own lobby', async () => {
    const first = await joinOrHost(rider('alice'), 'alice', 'ALICE');
    const second = await joinOrHost(rider('alice'), 'alice', 'ALICE');
    expect(second.id).not.toBe(first.id);
    expect(second.isHost).toBe(true);
  });

  it('gives the same seat to only one of two simultaneous riders', async () => {
    await joinOrHost(rider('alice'), 'alice', 'ALICE');
    const [a, b] = await Promise.all([
      joinOrHost(rider('bob'), 'bob', 'BOB'),
      joinOrHost(rider('cass'), 'cass', 'CASS'),
    ]);
    // Whatever order they land in, they cannot be in the same seat of the
    // same lobby. This is the race the server has to settle, not the client.
    expect(a.id === b.id && a.slot === b.slot).toBe(false);
  });

  it('honours a supplied seed so a host can be handed one', async () => {
    const h = await joinOrHost(rider('alice'), 'alice', 'ALICE', { seed: 4242 });
    expect(h.seed).toBe(4242);
  });
});

describe('leaving', () => {
  it('a guest frees their seat and leaves the lobby standing', async () => {
    const host = await joinOrHost(rider('alice'), 'alice', 'ALICE');
    const guest = await joinOrHost(rider('bob'), 'bob', 'BOB');

    await leave(rider('bob'), guest);

    const lobby = await raw((db) => get(ref(db, `lobbies/${host.id}`)));
    expect(lobby.exists()).toBe(true);
    expect(lobby.val().slots[String(FIRST_SEAT - 1)]).toBeUndefined();
    expect(lobby.val().slots[String(FIRST_SEAT)]).toBeTruthy();
  });

  it('a host takes the whole lobby with them', async () => {
    const host = await joinOrHost(rider('alice'), 'alice', 'ALICE');
    await leave(rider('alice'), host);
    const lobby = await raw((db) => get(ref(db, `lobbies/${host.id}`)));
    expect(lobby.exists()).toBe(false);
  });

  it('frees the seat for the next rider to take', async () => {
    await joinOrHost(rider('alice'), 'alice', 'ALICE');
    const bob = await joinOrHost(rider('bob'), 'bob', 'BOB');
    await leave(rider('bob'), bob);

    const cass = await joinOrHost(rider('cass'), 'cass', 'CASS');
    expect(cass.slot).toBe(FIRST_SEAT - 1);
    expect(cass.isHost).toBe(false);
  });
});

describe('custom rooms', () => {
  it('opens a room with a code and keeps it out of matchmaking', async () => {
    const room = await createRoom(rider('alice'), 'alice', 'ALICE');
    expect(room.isHost).toBe(true);
    expect(room.code).toHaveLength(CODE_LENGTH);

    // Quick Match must not stumble into somebody's private room.
    const stranger = await joinOrHost(rider('bob'), 'bob', 'BOB');
    expect(stranger.id).not.toBe(room.id);
    expect(stranger.isHost).toBe(true);
  });

  it('lets a friend in with the code', async () => {
    const room = await createRoom(rider('alice'), 'alice', 'ALICE');
    const friend = await joinByCode(rider('bob'), 'bob', 'BOB', room.code);
    expect(friend).not.toBeNull();
    expect(friend!.id).toBe(room.id);
    expect(friend!.slot).toBe(FIRST_SEAT - 1);
    expect(friend!.seed).toBe(room.seed);
  });

  it('accepts a code however it was typed', async () => {
    const room = await createRoom(rider('alice'), 'alice', 'ALICE');
    const messy = ` ${room.code.toLowerCase()} `;
    expect(await joinByCode(rider('bob'), 'bob', 'BOB', messy)).not.toBeNull();
  });

  it('says no to a code that does not exist', async () => {
    // A wrong code has to be distinguishable from success, so unlike Quick
    // Match this never quietly opens a room of its own instead.
    expect(await joinByCode(rider('bob'), 'bob', 'BOB', 'QQQQ')).toBeNull();
  });

  it('says no to a code of the wrong shape', async () => {
    expect(await joinByCode(rider('bob'), 'bob', 'BOB', 'AB')).toBeNull();
    expect(await joinByCode(rider('bob'), 'bob', 'BOB', '')).toBeNull();
  });

  it('says no once the room is full', async () => {
    const room = await createRoom(rider('alice'), 'alice', 'ALICE');
    for (let i = 1; i < GRID_SLOTS; i++) {
      expect(await joinByCode(rider(`r${i}`), `r${i}`, `R${i}`, room.code)).not.toBeNull();
    }
    expect(await joinByCode(rider('late'), 'late', 'LATE', room.code)).toBeNull();
  });
});

describe('dropping the flag', () => {
  it('lets the owner start, and everyone watching sees it', async () => {
    const room = await createRoom(rider('alice'), 'alice', 'ALICE');
    await joinByCode(rider('bob'), 'bob', 'BOB', room.code);

    const seen: boolean[] = [];
    const stop = watchRoom(rider('bob'), room.id, (state) => {
      if (state) seen.push(state.started);
    });

    // Wait for the watcher's opening state before dropping the flag. Racing
    // the subscription meant the first callback sometimes arrived *after* the
    // start was written, so `seen[0]` was already true - which is exactly how
    // this test flaked before.
    await waitFor(() => seen.length > 0);
    expect(seen[0]).toBe(false);

    await startRace(rider('alice'), room);
    await waitFor(() => seen.at(-1) === true);
    stop();

    expect(seen.at(-1)).toBe(true);
  });

  it('is a no-op for a guest', async () => {
    const room = await createRoom(rider('alice'), 'alice', 'ALICE');
    const friend = (await joinByCode(rider('bob'), 'bob', 'BOB', room.code))!;
    await startRace(rider('bob'), friend);

    const snap = await raw((db) => get(ref(db, `lobbies/${room.id}/startedAt`)));
    expect(snap.exists()).toBe(false);
  });

  it('keeps matchmaking out of a race already under way', async () => {
    const host = await joinOrHost(rider('alice'), 'alice', 'ALICE');
    await startRace(rider('alice'), host);
    await new Promise((r) => setTimeout(r, 200));

    // Still "open", but running - a rider dropped in now has no lobby to wait in.
    const late = await joinOrHost(rider('late'), 'late', 'LATE');
    expect(late.id).not.toBe(host.id);
  });

  it('will not let a guest join a running room by code either', async () => {
    const room = await createRoom(rider('alice'), 'alice', 'ALICE');
    await startRace(rider('alice'), room);
    await new Promise((r) => setTimeout(r, 200));
    expect(await joinByCode(rider('bob'), 'bob', 'BOB', room.code)).toBeNull();
  });
});

describe('watching a room', () => {
  it('reports null when the owner takes the room away', async () => {
    const room = await createRoom(rider('alice'), 'alice', 'ALICE');
    const seen: Array<unknown> = [];
    const stop = watchRoom(rider('bob'), room.id, (s) => void seen.push(s));
    await new Promise((r) => setTimeout(r, 150));

    await leave(rider('alice'), room);
    await waitFor(() => seen.at(-1) === null);
    stop();

    expect(seen.at(-1)).toBeNull();
  });
});

import { readFileSync } from 'node:fs';
import { get, ref, remove, set, update } from 'firebase/database';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ALICE = 'alice';
const BOB = 'bob';
const MALLORY = 'mallory';

let env: RulesTestEnvironment;

/** A lobby exactly as the client creates it, hosted by `host`. */
function lobby(host: string, open = true, code = 'AB23') {
  return { host, seed: 1234, createdAt: { '.sv': 'timestamp' }, open, code };
}

/** Seed data straight past the rules, for "given an existing lobby" setups. */
async function seed(path: string, value: unknown): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await set(ref(ctx.database(), path), value);
  });
}

const as = (uid: string) => env.authenticatedContext(uid).database();
const anon = () => env.unauthenticatedContext().database();

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

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearDatabase();
});

describe('signed-out players', () => {
  it('cannot read the lobby list', async () => {
    await seed('lobbies/l1', lobby(ALICE));
    await assertFails(get(ref(anon(), 'lobbies')));
  });

  it('cannot create a lobby', async () => {
    await assertFails(set(ref(anon(), 'lobbies/l1'), lobby(ALICE)));
  });

  it('cannot join an existing lobby', async () => {
    await seed('lobbies/l1', lobby(ALICE));
    await assertFails(set(ref(anon(), 'lobbies/l1/slots/3'), { uid: BOB, name: 'Bob' }));
  });
});

describe('creating a lobby', () => {
  it('lets a signed-in player host one', async () => {
    await assertSucceeds(set(ref(as(ALICE), 'lobbies/l1'), lobby(ALICE)));
  });

  it('refuses a lobby that names someone else as host', async () => {
    await assertFails(set(ref(as(MALLORY), 'lobbies/l1'), lobby(ALICE)));
  });

  it('refuses a lobby missing required fields', async () => {
    await assertFails(set(ref(as(ALICE), 'lobbies/l1'), { host: ALICE, seed: 1 }));
  });

  it('refuses a back-dated createdAt', async () => {
    await assertFails(
      set(ref(as(ALICE), 'lobbies/l1'), { ...lobby(ALICE), createdAt: 1 }),
    );
  });

  it('refuses unknown fields on the lobby', async () => {
    await assertFails(
      set(ref(as(ALICE), 'lobbies/l1'), { ...lobby(ALICE), trophies: 9000 }),
    );
  });
});

describe('matchmaking reads', () => {
  it('lets any signed-in player see open lobbies', async () => {
    await seed('lobbies/l1', lobby(ALICE));
    const snap = await assertSucceeds(get(ref(as(BOB), 'lobbies')));
    expect(snap.val()).toHaveProperty('l1');
  });
});

describe('lobby ownership', () => {
  beforeEach(async () => {
    await seed('lobbies/l1', lobby(ALICE));
  });

  it('lets the host close the lobby', async () => {
    await assertSucceeds(update(ref(as(ALICE), 'lobbies/l1'), { open: false }));
  });

  it('stops a non-host closing the lobby', async () => {
    await assertFails(update(ref(as(MALLORY), 'lobbies/l1'), { open: false }));
  });

  it('stops a non-host hijacking the host field', async () => {
    await assertFails(update(ref(as(MALLORY), 'lobbies/l1'), { host: MALLORY }));
  });

  it('lets the host remove the lobby (this is what onDisconnect fires)', async () => {
    await assertSucceeds(remove(ref(as(ALICE), 'lobbies/l1')));
  });

  it('stops a non-host removing the lobby', async () => {
    await assertFails(remove(ref(as(MALLORY), 'lobbies/l1')));
  });
});

describe('signaling', () => {
  it('lets a peer send as themselves', async () => {
    await assertSucceeds(
      set(ref(as(BOB), `signals/l1/${ALICE}/${BOB}`), { type: 'offer', sdp: 'v=0' }),
    );
  });

  it('stops a peer forging a message from someone else', async () => {
    await assertFails(
      set(ref(as(MALLORY), `signals/l1/${ALICE}/${BOB}`), { type: 'offer', sdp: 'v=0' }),
    );
  });

  it('lets the recipient read their own inbox', async () => {
    await seed(`signals/l1/${ALICE}/${BOB}`, { type: 'offer', sdp: 'v=0' });
    const snap = await assertSucceeds(get(ref(as(ALICE), `signals/l1/${ALICE}`)));
    expect(snap.val()).toHaveProperty(BOB);
  });

  // Regression: an earlier draft nested signals under /lobbies, where the
  // lobby-wide `.read` cascaded down and exposed every peer's ICE candidates,
  // and with them their IP address, to anyone signed in.
  it('hides a peer’s inbox from a third party in the same lobby', async () => {
    await seed(`signals/l1/${ALICE}/${BOB}`, { type: 'offer', sdp: 'v=0' });
    await seed('lobbies/l1', lobby(ALICE));
    await assertFails(get(ref(as(MALLORY), `signals/l1/${ALICE}`)));
  });

  it('lets the recipient bin their own inbox once the handshake is done', async () => {
    await seed(`signals/l1/${ALICE}/${BOB}`, { description: { type: 'offer', sdp: 'v=0' } });
    await assertSucceeds(remove(ref(as(ALICE), `signals/l1/${ALICE}`)));
  });

  it('stops a rider binning somebody else’s inbox', async () => {
    await seed(`signals/l1/${ALICE}/${BOB}`, { description: { type: 'offer', sdp: 'v=0' } });
    await assertFails(remove(ref(as(MALLORY), `signals/l1/${ALICE}`)));
    await assertFails(remove(ref(as(BOB), `signals/l1/${ALICE}`)));
  });

  it('hides a peer’s inbox even from the other end of the call', async () => {
    await seed(`signals/l1/${ALICE}/${BOB}`, { type: 'offer', sdp: 'v=0' });
    await assertFails(get(ref(as(BOB), `signals/l1/${ALICE}`)));
  });
});

describe('taking a seat on the grid', () => {
  const seat = (n: number | string) => `lobbies/l1/slots/${n}`;

  beforeEach(async () => {
    await seed('lobbies/l1', lobby(ALICE));
  });

  it('lets a rider claim an empty seat', async () => {
    await assertSucceeds(set(ref(as(BOB), seat(3)), { uid: BOB, name: 'Bob' }));
  });

  it('refuses a seat somebody is already in', async () => {
    await seed(seat(3), { uid: MALLORY, name: 'Mal' });
    await assertFails(set(ref(as(BOB), seat(3)), { uid: BOB, name: 'Bob' }));
  });

  it('refuses a rider seating somebody else', async () => {
    await assertFails(set(ref(as(BOB), seat(3)), { uid: MALLORY, name: 'Mal' }));
  });

  it('stops even the host seating another uid in their own lobby', async () => {
    // The host's .write on the lobby root cascades down to the seats, but
    // .validate does not cascade, so this is still refused. That is a tighter
    // boundary than the old uid-keyed map gave us.
    await assertFails(set(ref(as(ALICE), seat(3)), { uid: BOB, name: 'Bob' }));
  });

  it('lets a rider rewrite their own seat', async () => {
    await seed(seat(3), { uid: BOB, name: 'Bob' });
    await assertSucceeds(set(ref(as(BOB), seat(3)), { uid: BOB, name: 'Bobby' }));
  });

  it('lets a rider vacate their own seat', async () => {
    await seed(seat(3), { uid: BOB, name: 'Bob' });
    await assertSucceeds(remove(ref(as(BOB), seat(3))));
  });

  it('stops a rider evicting another', async () => {
    await seed(seat(3), { uid: BOB, name: 'Bob' });
    await assertFails(remove(ref(as(MALLORY), seat(3))));
  });

  it('lets the host clear a seat in their own lobby, by design', async () => {
    // Same host-authority trade-off as everywhere else: a host who can evict
    // you can already decide whether your bike crashes.
    await seed(seat(3), { uid: BOB, name: 'Bob' });
    await assertSucceeds(remove(ref(as(ALICE), seat(3))));
  });

  it('caps the grid structurally - there is no ninth seat', async () => {
    // This is the whole reason for numbered slots: the rules language has no
    // numChildren(), so a counted cap is not expressible. An absent key is.
    await assertFails(set(ref(as(BOB), seat(8)), { uid: BOB, name: 'Bob' }));
    await assertFails(set(ref(as(BOB), seat(99)), { uid: BOB, name: 'Bob' }));
    await assertFails(set(ref(as(BOB), seat('x')), { uid: BOB, name: 'Bob' }));
  });

  it('requires both a uid and a name', async () => {
    await assertFails(set(ref(as(BOB), seat(3)), { uid: BOB }));
    await assertFails(set(ref(as(BOB), seat(3)), { name: 'Bob' }));
  });

  it('refuses an empty or over-long name', async () => {
    await assertFails(set(ref(as(BOB), seat(3)), { uid: BOB, name: '' }));
    await assertFails(set(ref(as(BOB), seat(3)), { uid: BOB, name: 'x'.repeat(17) }));
  });

  it('accepts a name of exactly 16 characters', async () => {
    await assertSucceeds(set(ref(as(BOB), seat(3)), { uid: BOB, name: 'x'.repeat(16) }));
  });

  it('refuses unknown fields on a seat', async () => {
    await assertFails(set(ref(as(BOB), seat(3)), { uid: BOB, name: 'Bob', wins: 9 }));
  });
});

describe('room codes', () => {
  it('accepts a well-formed code', async () => {
    await assertSucceeds(set(ref(as(ALICE), 'lobbies/l1'), lobby(ALICE, true, 'QX47')));
  });

  it('refuses a code with characters that get misread aloud', async () => {
    // The alphabet deliberately excludes O/0, I/1 and S/5.
    for (const code of ['AB0C', 'AB1C', 'AB5C', 'ABIC']) {
      await assertFails(set(ref(as(ALICE), `lobbies/${code}`), lobby(ALICE, true, code)));
    }
  });

  it('refuses a code of the wrong length', async () => {
    await assertFails(set(ref(as(ALICE), 'lobbies/l1'), lobby(ALICE, true, 'AB2')));
    await assertFails(set(ref(as(ALICE), 'lobbies/l2'), lobby(ALICE, true, 'AB234')));
  });

  it('refuses a lobby with no code at all', async () => {
    await assertFails(set(ref(as(ALICE), 'lobbies/l1'), {
      host: ALICE, seed: 1, createdAt: { '.sv': 'timestamp' }, open: true,
    }));
  });
});

describe('dropping the flag', () => {
  beforeEach(async () => {
    await seed('lobbies/l1', lobby(ALICE));
  });

  it('lets the host start the race', async () => {
    await assertSucceeds(
      set(ref(as(ALICE), 'lobbies/l1/startedAt'), { '.sv': 'timestamp' }),
    );
  });

  it('stops a guest starting it', async () => {
    await assertFails(
      set(ref(as(BOB), 'lobbies/l1/startedAt'), { '.sv': 'timestamp' }),
    );
  });

  it('refuses a back-dated start', async () => {
    await assertFails(set(ref(as(ALICE), 'lobbies/l1/startedAt'), 1));
  });

  it('lets the host put the room back in the lobby for a rematch', async () => {
    // Clearing the flag is what makes a second race in the same room possible.
    // Only the host can: the lobby root refuses everybody else, so a rider
    // still cannot restart a race from under the field.
    await seed('lobbies/l1/startedAt', 1700000000000);
    await assertSucceeds(remove(ref(as(ALICE), 'lobbies/l1/startedAt')));
    await assertSucceeds(
      set(ref(as(ALICE), 'lobbies/l1/startedAt'), { '.sv': 'timestamp' }),
    );
  });

  it('stops a guest clearing it', async () => {
    await seed('lobbies/l1/startedAt', 1700000000000);
    await assertFails(remove(ref(as(BOB), 'lobbies/l1/startedAt')));
  });

  it('still refuses a back-dated restart', async () => {
    await seed('lobbies/l1/startedAt', 1700000000000);
    await assertFails(set(ref(as(ALICE), 'lobbies/l1/startedAt'), 1));
  });

  it('lets the host roll a fresh track for the rematch', async () => {
    await assertSucceeds(set(ref(as(ALICE), 'lobbies/l1/seed'), 4242));
    await assertFails(set(ref(as(BOB), 'lobbies/l1/seed'), 4242));
  });
});

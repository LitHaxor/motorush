// The orchestrator against a real database, with the peer links faked so
// messages actually flow between two riders who really took seats.

import { readFileSync } from 'node:fs';
import type { Database } from 'firebase/database';
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIRST_SEAT } from '../../src/net/lobby';
import { type OnlineRace, goOnline } from '../../src/net/online';
import type { PeerLink, PeerLinkOptions } from '../../src/net/peer';
import type { NetSession } from '../../src/net/session';
import type { RacerInput } from '../../src/sim/types';

let env: RulesTestEnvironment;
const asModular = (db: unknown) => db as Database;
const dbFor = (uid: string): Database => asModular(env.authenticatedContext(uid).database());
const sessionFor = (uid: string): NetSession =>
  ({ db: dbFor(uid), uid } as unknown as NetSession);

const INPUT: RacerInput = {
  throttle: 1, brake: 0, steer: 0.25, attackLeft: false, attackRight: false,
};

/** Links that deliver to each other, standing in for a real connection. */
class Switchboard {
  private readonly links = new Map<string, FakeLink>();

  open = (options: PeerLinkOptions): PeerLink => {
    const link = new FakeLink(this, options.selfUid, options.peerUid, options.offerer);
    this.links.set(`${options.selfUid}->${options.peerUid}`, link);
    return link;
  };

  deliver(from: string, to: string, payload: string): void {
    this.links.get(`${to}->${from}`)?.receive(payload);
  }

  link(self: string, peer: string): FakeLink | undefined {
    return this.links.get(`${self}->${peer}`);
  }

  closeAll(): void {
    for (const l of this.links.values()) l.close();
    this.links.clear();
  }
}

class FakeLink implements PeerLink {
  state: PeerLink['state'] = 'open';
  private onMessageHandler: ((p: string) => void) | null = null;
  private onStateHandler: ((s: PeerLink['state']) => void) | null = null;
  readonly sent: string[] = [];

  constructor(
    private readonly board: Switchboard,
    readonly selfUid: string,
    readonly peerUid: string,
    readonly offerer: boolean,
  ) {}

  send(payload: string) {
    if (this.state !== 'open') return;
    this.sent.push(payload);
    this.board.deliver(this.selfUid, this.peerUid, payload);
  }
  receive(payload: string) { this.onMessageHandler?.(payload); }
  onMessage(h: (p: string) => void) { this.onMessageHandler = h; }
  onStateChange(h: (s: PeerLink['state']) => void) { this.onStateHandler = h; }
  close() {
    this.state = 'closed';
    this.onStateHandler?.('closed');
  }
  fail() {
    this.state = 'failed';
    this.onStateHandler?.('failed');
  }
}

/**
 * Both ends wired up.
 *
 * Waiting on only one side is a trap for any test that sends a single frame:
 * the other end's link is created from its own seat-watch callback, and a
 * message delivered before it exists is simply dropped. Live, the host sends
 * twenty frames a second so an early loss is invisible - but a test that
 * sends once needs both halves standing.
 */
const linked = (a: string, b: string) => () => !!board.link(a, b) && !!board.link(b, a);

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition never held');
}

let board: Switchboard;
const races: OnlineRace[] = [];
const online = async (uid: string, name: string): Promise<OnlineRace> => {
  const race = (await goOnline(sessionFor(uid), name, { openLink: board.open }))!;
  races.push(race);
  return race;
};

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
beforeEach(async () => { await env.clearDatabase(); board = new Switchboard(); });
afterEach(async () => {
  for (const r of races) await r.close().catch(() => {});
  races.length = 0;
  board.closeAll();
});

describe('taking a seat', () => {
  it('makes the first rider the host in seat zero', async () => {
    const host = await online('host', 'HOST');
    expect(host.isHost).toBe(true);
    expect(host.seat).toBe(FIRST_SEAT);
  });

  it('puts the second rider in seat one of the same lobby', async () => {
    const host = await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    expect(guest.isHost).toBe(false);
    expect(guest.seat).toBe(FIRST_SEAT - 1);
    expect(guest.lobbyId).toBe(host.lobbyId);
    expect(guest.seed).toBe(host.seed);
  });

  it('has the host offer and the guest answer', async () => {
    const host = await online('host', 'HOST');
    await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));
    expect(board.link('host', 'guest')!.offerer).toBe(true);
    expect(board.link('guest', 'host')!.offerer).toBe(false);
    expect(host.seats().length).toBe(2);
  });
});

describe('input flowing uphill', () => {
  it('lands in the host input map under the guest’s seat', async () => {
    const host = await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));

    guest.sendInput(INPUT, 1000);

    // A seat IS a Racer.id - this map goes straight into World.step.
    await waitFor(() => host.inputs(1000).has(FIRST_SEAT - 1));
    expect(host.inputs(1000).get(FIRST_SEAT - 1)).toMatchObject({ steer: 0.25 });
  });

  it('gives the bike back to the AI when the rider goes quiet', async () => {
    const host = await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));
    guest.sendInput(INPUT, 1000);
    await waitFor(() => host.inputs(1000).has(FIRST_SEAT - 1));

    // Far enough past the TTL that the seat has gone stale.
    expect(host.inputs(9000).has(FIRST_SEAT - 1)).toBe(false);
  });

  it('gives the bike back when the link fails', async () => {
    const host = await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));
    guest.sendInput(INPUT, 1000);
    await waitFor(() => host.inputs(1000).has(FIRST_SEAT - 1));

    board.link('host', 'guest')!.fail();
    expect(host.inputs(1000).has(FIRST_SEAT - 1)).toBe(false);
  });

  it('rate-limits what a guest sends', async () => {
    const host = await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));

    const link = board.link('guest', 'host')!;
    for (let ms = 0; ms < 100; ms += 1) guest.sendInput(INPUT, ms);
    // 30Hz over 100ms is three frames, not a hundred.
    expect(link.sent.length).toBeLessThanOrEqual(4);
  });

  it('ignores input arriving at a guest, which is not authoritative', async () => {
    const host = await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));
    host.sendInput(INPUT, 1000); // a host has nobody to send input to
    expect(board.link('host', 'guest')!.sent).toHaveLength(0);
    expect(guest.sample(1000)).toBeNull();
  });
});

describe('state flowing downhill', () => {
  const source = {
    racers: [{
      id: 0, s: 10, lateral: 0, speed: 30, lean: 0, health: 100, state: 'ride' as const,
      riderPhase: 'standing' as const, attackDir: 0 as const, place: 1,
    }],
    cars: [{
      id: 5, s: 300, lateral: 1, speed: 22, dir: 1 as const, brake: 0, swerve: 0.2,
      color: 0xff0000, type: { key: 'sedan', length: 4.5, width: 1.9, height: 1.45, weight: 4 },
    }],
    cops: [{
      id: 900, s: 60, lateral: 1, speed: 40, lean: 0, health: 100, hop: 0,
      state: 'ride' as const, riderPhase: 'standing' as const,
      attackDir: 0 as const, place: 8,
    }],
    peds: [],
    aroundS: 0,
    time: 5.0,
    phase: 'racing' as const,
    countdown: 0,
  };

  it('reaches the guest and can be drawn', async () => {
    const host = await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));

    host.broadcast(source as never, 1000);

    await waitFor(() => guest.sample(1000) !== null);
    const drawn = guest.sample(1000)!;
    expect(drawn.phase).toBe('racing');
    expect(drawn.racers[0]).toMatchObject({ id: 0, s: 10 });
    // Traffic rides along in the same frame, so a guest sees the same cars.
    expect(drawn.cars[0]).toMatchObject({ id: 5, s: 300, type: 'sedan' });
    // ...and so do patrols, which a guest cannot see any other way.
    expect(drawn.cops[0]).toMatchObject({ id: 900, s: 60 });
  });

  it('rate-limits the broadcast', async () => {
    const host = await online('host', 'HOST');
    await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));

    const link = board.link('host', 'guest')!;
    for (let ms = 0; ms < 100; ms += 1) host.broadcast(source as never, ms);
    // 20Hz over 100ms is two frames.
    expect(link.sent.length).toBeLessThanOrEqual(3);
  });

  it('does not broadcast into an empty lobby', async () => {
    const host = await online('host', 'HOST');
    expect(() => host.broadcast(source as never, 1000)).not.toThrow();
    expect(host.seats().length).toBeLessThanOrEqual(1);
  });

  it('a guest never broadcasts', async () => {
    await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));
    guest.broadcast(source as never, 1000);
    expect(board.link('guest', 'host')!.sent).toHaveLength(0);
  });
});

describe('closing the lobby', () => {
  // Closing happens when the race ENDS, not when it starts - see the note in
  // main.ts. These cover the mechanism; the trigger lives in the game loop.
  it('stops matchmaking sending anyone else in', async () => {
    const host = await online('host', 'HOST');
    await host.closeLobby();

    // A rider matched into a running race would start at the line behind the
    // whole field, so they must open their own lobby instead.
    const late = await online('late', 'LATE');
    expect(late.lobbyId).not.toBe(host.lobbyId);
    expect(late.isHost).toBe(true);
  });

  it('leaves riders already seated alone', async () => {
    const host = await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(() => host.seats().length === 2);

    await host.closeLobby();

    expect(guest.seat).toBe(FIRST_SEAT - 1);
    expect(host.seats().length).toBe(2);
  });

  it('is a no-op for a guest', async () => {
    await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await expect(guest.closeLobby()).resolves.toBeUndefined();
  });
});

describe('leaving', () => {
  it('drops the guest’s seat and their link', async () => {
    const host = await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(() => host.seats().length === 2);

    await guest.close();

    await waitFor(() => host.seats().length === 1);
    expect(host.inputs(1000).has(FIRST_SEAT - 1)).toBe(false);
  });
});

describe('knowing the link is alive', () => {
  it('answers a ping, so both ends can time the round trip', async () => {
    await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));

    guest.tick(0);
    await waitFor(() => board.link('host', 'guest')!.sent.some((m) => m.includes('"t":"pong"')));
  });

  it('measures a round trip between two clocks that share no origin', async () => {
    // The pair that started this: one browser open for minutes and the other
    // for days, with a rider on the other side of the world. Neither clock
    // means anything to the other, so the trip is measured, never assumed.
    await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));

    guest.tick(0);
    await waitFor(() => guest.ping(5000) !== null);
    expect(guest.ping(5000)).toBeGreaterThanOrEqual(0);
  });

  it('pings on a timer rather than on every frame', async () => {
    await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('guest', 'host'));

    const link = board.link('guest', 'host')!;
    const before = link.sent.length;
    for (let t = 0; t < 500; t += 16) guest.tick(t);
    expect(link.sent.length - before).toBeLessThanOrEqual(1);
  });

  it('reports a guest that has heard nothing as lost, not as fine', async () => {
    await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    // Nothing has been broadcast, so however healthy the link looks, this
    // guest has no race to draw - which is the state that used to freeze it.
    expect(guest.snapshotAgeMs(10_000)).toBe(Infinity);
    expect(guest.quality(10_000)).toBe('lost');
  });
});

describe('punches from another browser', () => {
  /** Drain repeatedly without losing what was drained. */
  const collect = async (race: OnlineRace) => {
    const seen: Array<{ id: number; dir: -1 | 1 }> = [];
    await waitFor(() => {
      seen.push(...race.attacks());
      return seen.length > 0;
    });
    return seen;
  };

  it('hands the host one swing per press', async () => {
    // A guest's punch used to travel as a flag on the input frame that
    // nothing on the host ever read, so the punch buttons did nothing at all
    // in an online race.
    const host = await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));

    expect(guest.sendInput({ ...INPUT, attackRight: true }, 0)).toBe(true);
    const seen = await collect(host);
    expect(seen[0]).toEqual({ id: guest.seat, dir: 1 });
  });

  it('knows which side was thrown', async () => {
    const host = await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));

    guest.sendInput({ ...INPUT, attackLeft: true }, 0);
    const seen = await collect(host);
    expect(seen[0]!.dir).toBe(-1);
  });

  it('drains them, so one press cannot swing twice', async () => {
    const host = await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('host', 'guest'));

    guest.sendInput({ ...INPUT, attackRight: true }, 0);
    await collect(host);
    expect(host.attacks()).toEqual([]);
  });

  it('tells a guest whether its frame actually went out', async () => {
    await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    await waitFor(linked('guest', 'host'));

    expect(guest.sendInput(INPUT, 0)).toBe(true);
    // Input is rate limited, so the very next frame is not sent - which is
    // precisely why a punch has to wait for one that is.
    expect(guest.sendInput(INPUT, 1)).toBe(false);
  });

  it('never queues a swing on the guest side', async () => {
    await online('host', 'HOST');
    const guest = await online('guest', 'GUEST');
    expect(guest.attacks()).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { type Database, get, ref } from 'firebase/database';
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Candidate,
  clearInbox,
  onCandidate,
  onDescription,
  sendCandidate,
  sendDescription,
} from '../../src/net/signal';

const LOBBY = 'lobby1';
const HOST = 'host';
const GUEST = 'guest';

let env: RulesTestEnvironment;
const asModular = (db: unknown) => db as Database;
const rider = (uid: string): Database => asModular(env.authenticatedContext(uid).database());

/** Resolve on the first value the listener sees, or reject on timeout. */
function first<T>(subscribe: (handle: (v: T) => void) => () => void, ms = 3000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error('nothing arrived')); }, ms);
    const stop = subscribe((v) => { clearTimeout(timer); stop(); resolve(v); });
  });
}

/** Collect everything that arrives over a window. */
function collect<T>(subscribe: (handle: (v: T) => void) => () => void, ms = 400): Promise<T[]> {
  return new Promise<T[]>((resolve) => {
    const seen: T[] = [];
    const stop = subscribe((v) => void seen.push(v));
    setTimeout(() => { stop(); resolve(seen); }, ms);
  });
}

const CANDIDATE: Candidate = {
  candidate: 'candidate:1 1 udp 2130706431 192.0.2.1 54321 typ host',
  sdpMid: '0',
  sdpMLineIndex: 0,
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
beforeEach(async () => { await env.clearDatabase(); });

describe('exchanging descriptions', () => {
  it('delivers an offer to the peer it is addressed to', async () => {
    await sendDescription(rider(HOST), LOBBY, GUEST, HOST, { type: 'offer', sdp: 'v=0 offer' });

    const got = await first<{ type: string; sdp: string }>((h) =>
      onDescription(rider(GUEST), LOBBY, GUEST, HOST, h),
    );
    expect(got).toEqual({ type: 'offer', sdp: 'v=0 offer' });
  });

  it('delivers an offer that was already waiting before anyone listened', async () => {
    // The usual case: the host offers the moment a guest takes a seat, well
    // before the guest has wired up its listener.
    await sendDescription(rider(HOST), LOBBY, GUEST, HOST, { type: 'offer', sdp: 'v=0 early' });
    await new Promise((r) => setTimeout(r, 150));

    const got = await first<{ sdp: string }>((h) =>
      onDescription(rider(GUEST), LOBBY, GUEST, HOST, h),
    );
    expect(got.sdp).toBe('v=0 early');
  });

  it('carries an answer back the other way', async () => {
    await sendDescription(rider(GUEST), LOBBY, HOST, GUEST, { type: 'answer', sdp: 'v=0 answer' });
    const got = await first<{ type: string }>((h) =>
      onDescription(rider(HOST), LOBBY, HOST, GUEST, h),
    );
    expect(got.type).toBe('answer');
  });

  it('replaces a previous description rather than stacking them', async () => {
    await sendDescription(rider(HOST), LOBBY, GUEST, HOST, { type: 'offer', sdp: 'first' });
    await sendDescription(rider(HOST), LOBBY, GUEST, HOST, { type: 'offer', sdp: 'second' });

    const snap = await get(ref(rider(GUEST), `signals/${LOBBY}/${GUEST}/${HOST}/description`));
    expect(snap.val().sdp).toBe('second');
  });
});

describe('exchanging candidates', () => {
  it('delivers each candidate, and keeps them all', async () => {
    await sendCandidate(rider(HOST), LOBBY, GUEST, HOST, CANDIDATE);
    await sendCandidate(rider(HOST), LOBBY, GUEST, HOST, { ...CANDIDATE, candidate: 'second' });

    const got = await collect<Candidate>((h) =>
      onCandidate(rider(GUEST), LOBBY, GUEST, HOST, h),
    );
    expect(got).toHaveLength(2);
    expect(got.map((c) => c.candidate)).toContain('second');
  });

  it('replays candidates that arrived before we started listening', async () => {
    // Trickled candidates are additive and each one is a route; dropping the
    // early ones costs connections.
    await sendCandidate(rider(HOST), LOBBY, GUEST, HOST, CANDIDATE);
    await new Promise((r) => setTimeout(r, 150));

    const got = await collect<Candidate>((h) =>
      onCandidate(rider(GUEST), LOBBY, GUEST, HOST, h),
    );
    expect(got).toHaveLength(1);
  });

  it('normalises the optional fields rather than dropping them', async () => {
    await sendCandidate(rider(HOST), LOBBY, GUEST, HOST, {
      candidate: 'c', sdpMid: null, sdpMLineIndex: null,
    });
    const got = await first<Candidate>((h) => onCandidate(rider(GUEST), LOBBY, GUEST, HOST, h));
    expect(got).toEqual({ candidate: 'c', sdpMid: null, sdpMLineIndex: null });
  });
});

describe('inbox hygiene', () => {
  it('lets the recipient bin the spent handshake', async () => {
    await sendDescription(rider(HOST), LOBBY, GUEST, HOST, { type: 'offer', sdp: 'v=0' });
    await sendCandidate(rider(HOST), LOBBY, GUEST, HOST, CANDIDATE);

    await clearInbox(rider(GUEST), LOBBY, GUEST);

    const snap = await get(ref(rider(GUEST), `signals/${LOBBY}/${GUEST}`));
    expect(snap.exists()).toBe(false);
  });

  it('stops the sender reading back what it sent', async () => {
    // Not an oversight: only the recipient can read a mailbox, and nothing in
    // the handshake needs the sender to re-read its own outbox.
    await sendDescription(rider(HOST), LOBBY, GUEST, HOST, { type: 'offer', sdp: 'v=0' });
    await expect(
      get(ref(rider(HOST), `signals/${LOBBY}/${GUEST}/${HOST}/description`)),
    ).rejects.toThrow();
  });
});

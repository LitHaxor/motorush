// The handshake choreography, run over the real signalling transport against
// the emulator. Only the WebRTC primitives are faked - Node has no
// RTCPeerConnection - so what is under test is who offers, who answers, and
// whether candidates survive arriving in the wrong order.

import { readFileSync } from 'node:fs';
import { type Database, get, ref } from 'firebase/database';
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PeerLink, STUN_SERVERS, openPeerLink } from '../../src/net/peer';
import { sendCandidate, sendDescription } from '../../src/net/signal';

const LOBBY = 'lobby1';
const HOST = 'host';
const GUEST = 'guest';

let env: RulesTestEnvironment;
const asModular = (db: unknown) => db as Database;
const rider = (uid: string): Database => asModular(env.authenticatedContext(uid).database());

class FakeChannel {
  readyState: RTCDataChannelState = 'connecting';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(readonly label: string, readonly options?: RTCDataChannelInit) {}
  send(payload: string) {
    if (this.readyState !== 'open') throw new Error('not open');
    this.sent.push(payload);
  }
  close() { this.readyState = 'closed'; this.onclose?.(); }
  open() { this.readyState = 'open'; this.onopen?.(); }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ondatachannel: ((e: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly added: RTCIceCandidateInit[] = [];
  channel: FakeChannel | null = null;
  closed = false;

  constructor(readonly config: RTCConfiguration, readonly tag: string) {}

  createDataChannel(label: string, options?: RTCDataChannelInit) {
    this.channel = new FakeChannel(label, options);
    return this.channel;
  }
  async createOffer() { return { type: 'offer', sdp: `sdp-offer-${this.tag}` }; }
  async createAnswer() { return { type: 'answer', sdp: `sdp-answer-${this.tag}` }; }
  async setLocalDescription(d: RTCSessionDescriptionInit) { this.localDescription = d; }
  async setRemoteDescription(d: RTCSessionDescriptionInit) { this.remoteDescription = d; }
  async addIceCandidate(c: RTCIceCandidateInit) {
    // The real API throws if there is no remote description yet. That is the
    // whole reason the link buffers candidates, so the fake must do it too.
    if (!this.remoteDescription) throw new Error('no remote description');
    this.added.push(c);
  }
  close() { this.closed = true; }

  /** Pretend the ICE agent found a route. */
  emit(candidate: string) {
    this.onicecandidate?.({
      candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0 },
    });
  }
  /** Pretend the guest's channel arrived. */
  acceptChannel() {
    const ch = new FakeChannel('race');
    this.channel = ch;
    this.ondatachannel?.({ channel: ch });
    return ch;
  }
}

const make = (tag: string) => {
  let made: FakePeerConnection | null = null;
  const factory = (config: RTCConfiguration) => {
    made = new FakePeerConnection(config, tag);
    return made as unknown as RTCPeerConnection;
  };
  return { factory, get pc() { return made!; } };
};

/**
 * Every link opened by a test, closed afterwards. A link that outlives its
 * test keeps its database listeners, and a stray guest will happily answer
 * the *next* test's offer - which is exactly how this suite first failed.
 */
const links: PeerLink[] = [];
function open(options: Parameters<typeof openPeerLink>[0]): PeerLink {
  const link = openPeerLink(options);
  links.push(link);
  return link;
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition never held');
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
afterEach(() => {
  for (const link of links) link.close();
  links.length = 0;
});

describe('configuration', () => {
  it('offers several STUN servers and no TURN', () => {
    // No TURN is a cost decision, not an oversight: relaying is the only part
    // of this that bills. The riders it fails race bots instead.
    expect(STUN_SERVERS.length).toBeGreaterThan(1);
    for (const s of STUN_SERVERS) expect(String(s.urls)).toMatch(/^stun:/);
  });

  it('opens an unreliable, unordered channel', () => {
    const host = make('host');
    open({
      db: rider(HOST), lobbyId: LOBBY, selfUid: HOST, peerUid: GUEST,
      offerer: true, createConnection: host.factory,
    });
    // A stale position is worth less than a fresh one, so never retransmit.
    expect(host.pc.channel!.options).toMatchObject({ ordered: false, maxRetransmits: 0 });
  });
});

describe('the handshake', () => {
  it('has the host offer and the guest answer', async () => {
    const host = make('host');
    const guest = make('guest');

    open({
      db: rider(HOST), lobbyId: LOBBY, selfUid: HOST, peerUid: GUEST,
      offerer: true, createConnection: host.factory,
    });
    open({
      db: rider(GUEST), lobbyId: LOBBY, selfUid: GUEST, peerUid: HOST,
      offerer: false, createConnection: guest.factory,
    });

    // Guest takes the offer and produces an answer...
    await waitFor(() => guest.pc.remoteDescription?.type === 'offer');
    await waitFor(() => guest.pc.localDescription?.type === 'answer');
    // ...which finds its way back to the host.
    await waitFor(() => host.pc.remoteDescription?.type === 'answer');
    expect(host.pc.remoteDescription!.sdp).toBe('sdp-answer-guest');
  });

  it('only the host creates the data channel', async () => {
    const host = make('host');
    const guest = make('guest');
    open({
      db: rider(HOST), lobbyId: LOBBY, selfUid: HOST, peerUid: GUEST,
      offerer: true, createConnection: host.factory,
    });
    open({
      db: rider(GUEST), lobbyId: LOBBY, selfUid: GUEST, peerUid: HOST,
      offerer: false, createConnection: guest.factory,
    });
    expect(host.pc.channel).toBeTruthy();
    expect(guest.pc.channel).toBeNull();
  });

  it('ignores a description of the wrong kind', async () => {
    // A replayed offer must not reset a host that is already negotiating.
    const host = make('host');
    open({
      db: rider(HOST), lobbyId: LOBBY, selfUid: HOST, peerUid: GUEST,
      offerer: true, createConnection: host.factory,
    });
    await sendDescription(rider(GUEST), LOBBY, HOST, GUEST, { type: 'offer', sdp: 'bogus' });
    await new Promise((r) => setTimeout(r, 300));
    expect(host.pc.remoteDescription).toBeNull();
  });
});

describe('ICE candidates', () => {
  it('carries a candidate to the other end', async () => {
    const host = make('host');
    const guest = make('guest');
    open({
      db: rider(HOST), lobbyId: LOBBY, selfUid: HOST, peerUid: GUEST,
      offerer: true, createConnection: host.factory,
    });
    open({
      db: rider(GUEST), lobbyId: LOBBY, selfUid: GUEST, peerUid: HOST,
      offerer: false, createConnection: guest.factory,
    });

    await waitFor(() => guest.pc.remoteDescription !== null);
    host.pc.emit('candidate:host-1');
    await waitFor(() => guest.pc.added.length === 1);
    expect(guest.pc.added[0].candidate).toBe('candidate:host-1');
  });

  it('holds candidates that arrive before the description, then applies them', async () => {
    // This is the classic WebRTC race. Without buffering, addIceCandidate
    // throws and that route is silently lost.
    const guest = make('guest');
    open({
      db: rider(GUEST), lobbyId: LOBBY, selfUid: GUEST, peerUid: HOST,
      offerer: false, createConnection: guest.factory,
    });

    await sendCandidate(rider(HOST), LOBBY, GUEST, HOST, {
      candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0,
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(guest.pc.added).toHaveLength(0); // held, not thrown away

    await sendDescription(rider(HOST), LOBBY, GUEST, HOST, { type: 'offer', sdp: 'v=0' });
    await waitFor(() => guest.pc.added.length === 1);
    expect(guest.pc.added[0].candidate).toBe('candidate:early');
  });

  it('does not forward the end-of-gathering marker', async () => {
    const host = make('host');
    open({
      db: rider(HOST), lobbyId: LOBBY, selfUid: HOST, peerUid: GUEST,
      offerer: true, createConnection: host.factory,
    });
    host.pc.onicecandidate?.({ candidate: null });
    await new Promise((r) => setTimeout(r, 200));
    const snap = await get(ref(rider(GUEST), `signals/${LOBBY}/${GUEST}/${HOST}/candidates`));
    expect(snap.exists()).toBe(false);
  });
});

describe('the open link', () => {
  it('reports open and bins the spent handshake', async () => {
    const host = make('host');
    const link = open({
      db: rider(HOST), lobbyId: LOBBY, selfUid: HOST, peerUid: GUEST,
      offerer: true, createConnection: host.factory,
    });
    await sendDescription(rider(GUEST), LOBBY, HOST, GUEST, { type: 'answer', sdp: 'v=0' });
    await waitFor(() => host.pc.remoteDescription !== null);

    host.pc.channel!.open();
    expect(link.state).toBe('open');

    // Those candidates carry IP addresses; not keeping them beats keeping them.
    await new Promise((r) => setTimeout(r, 300));
    const snap = await get(ref(rider(HOST), `signals/${LOBBY}/${HOST}`));
    expect(snap.exists()).toBe(false);
  });

  it('sends once open', async () => {
    const host = make('host');
    const link = open({
      db: rider(HOST), lobbyId: LOBBY, selfUid: HOST, peerUid: GUEST,
      offerer: true, createConnection: host.factory,
    });
    host.pc.channel!.open();
    link.send('hello');
    expect(host.pc.channel!.sent).toEqual(['hello']);
  });

  it('drops a frame rather than throwing when the channel is not open', () => {
    const host = make('host');
    const link = open({
      db: rider(HOST), lobbyId: LOBBY, selfUid: HOST, peerUid: GUEST,
      offerer: true, createConnection: host.factory,
    });
    // The next frame is along in milliseconds and is worth more than this one.
    expect(() => link.send('dropped')).not.toThrow();
    expect(host.pc.channel!.sent).toEqual([]);
  });

  it('surfaces inbound messages', async () => {
    const host = make('host');
    const link = open({
      db: rider(HOST), lobbyId: LOBBY, selfUid: HOST, peerUid: GUEST,
      offerer: true, createConnection: host.factory,
    });
    const seen: string[] = [];
    link.onMessage((m) => void seen.push(m));
    host.pc.channel!.open();
    host.pc.channel!.onmessage?.({ data: 'tick' });
    expect(seen).toEqual(['tick']);
  });

  it('reports a failed connection', async () => {
    const host = make('host');
    const link = open({
      db: rider(HOST), lobbyId: LOBBY, selfUid: HOST, peerUid: GUEST,
      offerer: true, createConnection: host.factory,
    });
    const states: string[] = [];
    link.onStateChange((s) => void states.push(s));
    host.pc.connectionState = 'failed';
    host.pc.onconnectionstatechange?.();
    expect(link.state).toBe('failed');
    expect(states).toContain('failed');
  });

  it('closes the connection and stops listening', async () => {
    const host = make('host');
    const link = open({
      db: rider(HOST), lobbyId: LOBBY, selfUid: HOST, peerUid: GUEST,
      offerer: true, createConnection: host.factory,
    });
    link.close();
    expect(host.pc.closed).toBe(true);
    expect(link.state).toBe('closed');

    // A late answer must not revive a closed link.
    await sendDescription(rider(GUEST), LOBBY, HOST, GUEST, { type: 'answer', sdp: 'late' });
    await new Promise((r) => setTimeout(r, 250));
    expect(host.pc.remoteDescription).toBeNull();
  });
});

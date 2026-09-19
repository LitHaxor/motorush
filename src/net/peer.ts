// One direct browser-to-browser link, negotiated over the signalling letterbox.
//
// The host offers and the guest answers, so a lobby is a star: every guest
// holds one link to the host, and guests never connect to each other. That is
// what makes a failed connection survivable - the host only needs to be
// reachable by each guest individually, and a guest who cannot reach them
// simply races bots instead.
//
// No TURN server is configured, deliberately. Roughly one connection in five
// cannot be made to work with STUN alone, and relaying the ones that can't is
// the only part of this that would cost money. Those riders fall back to bots.

import type { Database } from 'firebase/database';
import {
  type Candidate,
  clearInbox,
  onCandidate,
  onDescription,
  sendCandidate,
  sendDescription,
} from './signal';

/** Public STUN only. Several, so candidate gathering doesn't hinge on one host. */
export const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** Unreliable and unordered: a stale position update is worth less than a fresh one. */
const CHANNEL_OPTIONS: RTCDataChannelInit = {
  ordered: false,
  maxRetransmits: 0,
};

const CHANNEL_LABEL = 'race';

export type LinkState = 'connecting' | 'open' | 'closed' | 'failed';

export interface PeerLinkOptions {
  db: Database;
  lobbyId: string;
  selfUid: string;
  peerUid: string;
  /** The host offers and creates the channel; the guest waits and answers. */
  offerer: boolean;
  iceServers?: RTCIceServer[];
  /** Injected so the choreography is testable without a browser. */
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

export interface PeerLink {
  readonly peerUid: string;
  readonly state: LinkState;
  send(payload: string): void;
  onMessage(handle: (payload: string) => void): void;
  onStateChange(handle: (state: LinkState) => void): void;
  close(): void;
}

export function openPeerLink(options: PeerLinkOptions): PeerLink {
  const {
    db, lobbyId, selfUid, peerUid, offerer,
    iceServers = STUN_SERVERS,
    createConnection = (config) => new RTCPeerConnection(config),
  } = options;

  const pc = createConnection({ iceServers });

  let channel: RTCDataChannel | null = null;
  let state: LinkState = 'connecting';
  let onMessageHandler: ((payload: string) => void) | null = null;
  let onStateHandler: ((state: LinkState) => void) | null = null;
  const unsubscribes: Array<() => void> = [];

  /**
   * Candidates routinely arrive before the description they belong to.
   * Adding one then throws, so they wait here until there is a remote
   * description to attach them to.
   */
  let remoteReady = false;
  const pending: Candidate[] = [];

  const setState = (next: LinkState) => {
    if (state === next || state === 'closed') return;
    state = next;
    onStateHandler?.(next);
  };

  const attachChannel = (ch: RTCDataChannel) => {
    channel = ch;
    ch.onopen = () => {
      setState('open');
      // The handshake is spent, and those candidates carry our IP addresses.
      void clearInbox(db, lobbyId, selfUid).catch(() => {});
    };
    ch.onclose = () => setState('closed');
    ch.onmessage = (e) => {
      if (typeof e.data === 'string') onMessageHandler?.(e.data);
    };
  };

  const drainCandidates = async () => {
    remoteReady = true;
    while (pending.length > 0) {
      const c = pending.shift()!;
      await pc.addIceCandidate(c).catch(() => {});
    }
  };

  pc.onicecandidate = (e) => {
    if (!e.candidate) return; // null marks the end of gathering
    void sendCandidate(db, lobbyId, peerUid, selfUid, {
      candidate: e.candidate.candidate,
      sdpMid: e.candidate.sdpMid,
      sdpMLineIndex: e.candidate.sdpMLineIndex,
    }).catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'failed') setState('failed');
    else if (s === 'disconnected' || s === 'closed') setState('closed');
  };

  if (offerer) {
    attachChannel(pc.createDataChannel(CHANNEL_LABEL, CHANNEL_OPTIONS));
  } else {
    pc.ondatachannel = (e) => attachChannel(e.channel);
  }

  unsubscribes.push(
    onDescription(db, lobbyId, selfUid, peerUid, (description) => {
      void (async () => {
        try {
          // An offerer only ever expects an answer, and vice versa. Ignoring
          // the wrong kind keeps a replayed message from resetting the link.
          if (offerer && description.type !== 'answer') return;
          if (!offerer && description.type !== 'offer') return;

          await pc.setRemoteDescription(description as RTCSessionDescriptionInit);
          await drainCandidates();

          if (!offerer) {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await sendDescription(db, lobbyId, peerUid, selfUid, {
              type: 'answer',
              sdp: answer.sdp ?? '',
            });
          }
        } catch {
          setState('failed');
        }
      })();
    }),
  );

  unsubscribes.push(
    onCandidate(db, lobbyId, selfUid, peerUid, (candidate) => {
      if (!remoteReady) {
        pending.push(candidate);
        return;
      }
      void pc.addIceCandidate(candidate).catch(() => {});
    }),
  );

  if (offerer) {
    void (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendDescription(db, lobbyId, peerUid, selfUid, {
          type: 'offer',
          sdp: offer.sdp ?? '',
        });
      } catch {
        setState('failed');
      }
    })();
  }

  return {
    peerUid,
    get state() { return state; },
    send(payload: string) {
      // Dropping a frame when the channel is not open is correct: the next
      // one is along in a few milliseconds and is worth more.
      if (channel?.readyState === 'open') {
        try { channel.send(payload); } catch { /* buffer full, drop it */ }
      }
    },
    onMessage(handle) { onMessageHandler = handle; },
    onStateChange(handle) { onStateHandler = handle; },
    close() {
      for (const stop of unsubscribes) stop();
      unsubscribes.length = 0;
      try { channel?.close(); } catch { /* already gone */ }
      try { pc.close(); } catch { /* already gone */ }
      setState('closed');
      state = 'closed';
    },
  };
}

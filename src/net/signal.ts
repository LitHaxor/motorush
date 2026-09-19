// The signalling transport: how two browsers swap the handshake needed to open
// a direct connection, using the database as a letterbox.
//
// Only the handshake goes through here. Once the peer connection is up, the
// race itself never touches Firebase again - which is what keeps this free.
//
// Addressing mirrors the security rules: a message lives at
//   signals/<lobby>/<recipient>/<sender>
// so "only the recipient may read" and "you may only send as yourself" are
// both expressible as rules. A sender deliberately cannot read their own
// outbox; nothing needs to.

import {
  type Database,
  type Unsubscribe,
  onChildAdded,
  onValue,
  push,
  ref,
  remove,
  serverTimestamp,
  set,
} from 'firebase/database';

/** An SDP offer or answer. */
export interface Description {
  type: 'offer' | 'answer';
  sdp: string;
}

/** One ICE candidate, flattened to the fields that survive JSON. */
export interface Candidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

const inbox = (lobbyId: string, self: string) => `signals/${lobbyId}/${self}`;
const mailbox = (lobbyId: string, to: string, from: string) =>
  `signals/${lobbyId}/${to}/${from}`;

/** Post our offer or answer to a peer. Overwrites any previous one. */
export async function sendDescription(
  db: Database,
  lobbyId: string,
  to: string,
  from: string,
  description: Description,
): Promise<void> {
  await set(ref(db, `${mailbox(lobbyId, to, from)}/description`), {
    type: description.type,
    sdp: description.sdp,
    at: serverTimestamp(),
  });
}

/**
 * Post one ICE candidate. Candidates are pushed rather than set: they arrive
 * as a trickle, each one is additive, and losing any of them costs a
 * connection route.
 */
export async function sendCandidate(
  db: Database,
  lobbyId: string,
  to: string,
  from: string,
  candidate: Candidate,
): Promise<void> {
  await push(ref(db, `${mailbox(lobbyId, to, from)}/candidates`), {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
  });
}

/**
 * Watch our inbox for a description from `from`.
 *
 * Fires on the current value too, not just changes, because the offer is
 * routinely already sitting there before we start listening.
 */
export function onDescription(
  db: Database,
  lobbyId: string,
  self: string,
  from: string,
  handle: (description: Description) => void,
): Unsubscribe {
  return onValue(ref(db, `${inbox(lobbyId, self)}/${from}/description`), (snap) => {
    const v = snap.val() as (Description & { at?: unknown }) | null;
    if (v && (v.type === 'offer' || v.type === 'answer') && typeof v.sdp === 'string') {
      handle({ type: v.type, sdp: v.sdp });
    }
  });
}

/**
 * Watch our inbox for candidates from `from`.
 *
 * onChildAdded replays everything already there and then streams new ones, so
 * a candidate that arrived before we were listening is not lost.
 */
export function onCandidate(
  db: Database,
  lobbyId: string,
  self: string,
  from: string,
  handle: (candidate: Candidate) => void,
): Unsubscribe {
  return onChildAdded(ref(db, `${inbox(lobbyId, self)}/${from}/candidates`), (snap) => {
    const v = snap.val() as Candidate | null;
    if (v && typeof v.candidate === 'string') {
      handle({
        candidate: v.candidate,
        sdpMid: v.sdpMid ?? null,
        sdpMLineIndex: v.sdpMLineIndex ?? null,
      });
    }
  });
}

/**
 * Drop our whole inbox for this lobby.
 *
 * Worth doing once connected: the handshake is spent, and the candidates in it
 * carry our IP addresses. The rules keep them private, but not keeping them at
 * all is better.
 */
export async function clearInbox(db: Database, lobbyId: string, self: string): Promise<void> {
  await remove(ref(db, inbox(lobbyId, self)));
}

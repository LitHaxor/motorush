// How well a link is actually working, measured rather than assumed.
//
// A data channel reports itself "open" long after it has stopped carrying
// anything - a phone that walked into a lift, a tab the OS froze, a host that
// wandered onto a worse network. Nothing in WebRTC tells us that, so we have
// to ask: a small ping goes down every link on a timer and the reply carries
// enough to work out both the round trip and how far apart the two clocks are.
//
// ABOUT CLOCKS. The two browsers share no notion of time whatsoever. Both use
// performance.now(), which counts from whenever that page happened to load, so
// the raw numbers can differ by hours - and if either end ever used a wall
// clock, by whole timezones. Nothing here ever compares the two directly. The
// offset is *measured* the way NTP measures it, from four timestamps on one
// round trip, which cancels the difference out whatever it is:
//
//   t0 we send   t1 they receive   t2 they reply   t3 we receive
//   rtt    = (t3 - t0) - (t2 - t1)        time on the wire, minus their delay
//   offset = ((t1 - t0) + (t2 - t3)) / 2  their clock minus ours
//
// So a rider in Dhaka and a rider in Berlin need agree on nothing at all.

/** One completed round trip. */
export interface PingSample {
  rttMs: number;
  /** Their clock minus ours, in milliseconds. */
  offsetMs: number;
}

/** What the HUD shows, and what the recovery logic switches on. */
export type LinkQuality = 'good' | 'fair' | 'poor' | 'lost';

export interface LinkHealthOptions {
  /** How often to ping. Cheap enough to be frequent; this is ~20 bytes. */
  intervalMs?: number;
  /** Silence beyond this and the link counts as lost, whatever it claims. */
  lostAfterMs?: number;
  /** Weight of each new sample in the running averages. */
  smoothing?: number;
}

const DEFAULTS = {
  intervalMs: 1000,
  lostAfterMs: 2500,
  smoothing: 0.25,
} as const;

/**
 * Running quality of one peer link.
 *
 * Deliberately knows nothing about sockets or timers: it is fed timestamps and
 * asked questions, which is what makes it testable without a browser.
 */
export class LinkHealth {
  private readonly intervalMs: number;
  private readonly lostAfterMs: number;
  private readonly smoothing: number;

  /** Pings sent and not yet answered, by id. */
  private readonly outstanding = new Map<number, number>();
  private nextId = 1;
  private nextPingAtMs = 0;

  private rtt: number | null = null;
  private jitter = 0;
  private offset: number | null = null;
  private lastHeardMs: number | null = null;
  private samples = 0;

  constructor(options: LinkHealthOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
    this.lostAfterMs = options.lostAfterMs ?? DEFAULTS.lostAfterMs;
    this.smoothing = options.smoothing ?? DEFAULTS.smoothing;
  }

  /** Smoothed round trip, or null until the first reply lands. */
  get rttMs(): number | null {
    return this.rtt;
  }

  /** How much the round trip wobbles - what the buffer has to absorb. */
  get jitterMs(): number {
    return this.jitter;
  }

  /** Their clock minus ours. Null until measured; never assumed to be zero. */
  get offsetMs(): number | null {
    return this.offset;
  }

  /** Replies still outstanding. Two or more in a row means trouble. */
  get pendingPings(): number {
    return this.outstanding.size;
  }

  /**
   * Anything at all arriving from the peer counts as a sign of life - a
   * snapshot is far better evidence than a pong, and far more frequent.
   */
  heard(nowMs: number): void {
    this.lastHeardMs = nowMs;
  }

  /** Milliseconds since anything last arrived. Infinity before the first. */
  silentMs(nowMs: number): number {
    if (this.lastHeardMs === null) return Infinity;
    return Math.max(0, nowMs - this.lastHeardMs);
  }

  /**
   * A ping id when one is due, otherwise null. Call it every frame.
   *
   * The id is remembered so the round trip is timed against our own clock and
   * never against a number the peer chose - a peer that lies about its
   * timestamps can skew its own reading, not ours.
   */
  pingDue(nowMs: number): number | null {
    if (nowMs < this.nextPingAtMs) return null;
    this.nextPingAtMs = nowMs + this.intervalMs;
    const id = this.nextId++;
    this.outstanding.set(id, nowMs);
    // Unanswered pings are not a memory leak waiting to happen: anything
    // older than the lost threshold is never coming back.
    for (const [old, atMs] of this.outstanding) {
      if (nowMs - atMs > this.lostAfterMs * 2) this.outstanding.delete(old);
    }
    return id;
  }

  /**
   * Fold in a reply. `peerRecvMs` and `peerSendMs` are on the peer's clock;
   * that is the whole point, and their absolute values are never used alone.
   */
  onPong(id: number, peerRecvMs: number, peerSendMs: number, nowMs: number): PingSample | null {
    const sentAtMs = this.outstanding.get(id);
    if (sentAtMs === undefined) return null; // duplicate, or far too late
    this.outstanding.delete(id);
    this.heard(nowMs);

    const theirDelay = Math.max(0, peerSendMs - peerRecvMs);
    const rttMs = Math.max(0, nowMs - sentAtMs - theirDelay);
    const offsetMs = ((peerRecvMs - sentAtMs) + (peerSendMs - nowMs)) / 2;

    if (this.rtt === null) {
      this.rtt = rttMs;
      this.offset = offsetMs;
    } else {
      // Jitter is measured against the average we held *before* this sample,
      // which is what makes it a spread rather than a lagging copy of the RTT.
      this.jitter = this.jitter + (Math.abs(rttMs - this.rtt) - this.jitter) * this.smoothing;
      this.rtt = this.rtt + (rttMs - this.rtt) * this.smoothing;
      this.offset = this.offset! + (offsetMs - this.offset!) * this.smoothing;
    }
    this.samples++;
    return { rttMs, offsetMs };
  }

  /**
   * The one-word verdict.
   *
   * Silence outranks a good ping: a link that went quiet two seconds ago is
   * lost no matter how fast it was while it worked.
   */
  quality(nowMs: number): LinkQuality {
    if (this.silentMs(nowMs) > this.lostAfterMs) return 'lost';
    if (this.rtt === null) return this.samples === 0 ? 'fair' : 'poor';
    if (this.rtt < 120 && this.jitter < 40) return 'good';
    if (this.rtt < 300) return 'fair';
    return 'poor';
  }

  /** Drop every measurement. Used when a link is rebuilt under us. */
  reset(): void {
    this.outstanding.clear();
    this.rtt = null;
    this.jitter = 0;
    this.offset = null;
    this.lastHeardMs = null;
    this.samples = 0;
    this.nextPingAtMs = 0;
  }
}

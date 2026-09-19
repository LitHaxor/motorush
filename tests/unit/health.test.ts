// The measurement that the recovery logic and the interpolation delay both
// stand on. Everything here is pure arithmetic over timestamps, so it runs
// without a browser, a network or a clock.

import { describe, it, expect } from 'vitest';
import { LinkHealth } from '../../src/net/health';

describe('measuring a link', () => {
  it('says nothing until a reply has actually come back', () => {
    const h = new LinkHealth();
    expect(h.rttMs).toBeNull();
    expect(h.offsetMs).toBeNull();
  });

  it('times the round trip with the peer\'s own handling taken out', () => {
    const h = new LinkHealth();
    const id = h.pingDue(0)!;
    // Sent at 0, they got it at 500, sat on it for 20ms, we saw the reply at
    // 220 on our clock: 220 on the wire and in their hands, less their 20.
    h.onPong(id, 500, 520, 220);
    expect(h.rttMs).toBe(200);
  });

  it('measures two clocks that share no origin at all', () => {
    // The whole point. One browser has been open for a minute, the other for
    // a week - and if either ever used a wall clock, they would be in
    // different timezones. Neither number means anything to the other, so the
    // offset is derived rather than assumed.
    const h = new LinkHealth();
    const OFFSET = 6 * 3600_000; // six hours ahead, in milliseconds
    const id = h.pingDue(1000)!;
    // One-way trip of 50ms each way, on top of that offset.
    h.onPong(id, 1050 + OFFSET, 1050 + OFFSET, 1100);
    expect(h.rttMs).toBe(100);
    expect(h.offsetMs).toBeCloseTo(OFFSET, 0);
  });

  it('is not fooled about the round trip by a peer sitting on the ping', () => {
    const h = new LinkHealth();
    const slow = h.pingDue(0)!;
    h.onPong(slow, 0, 400, 500); // 400ms of theirs, 100ms of wire
    expect(h.rttMs).toBe(100);
  });

  it('never reports a negative round trip, however odd the timestamps', () => {
    const h = new LinkHealth();
    const id = h.pingDue(0)!;
    h.onPong(id, 0, 9999, 10); // nonsense from the far end
    expect(h.rttMs).toBeGreaterThanOrEqual(0);
  });

  it('smooths the round trip rather than chasing every sample', () => {
    const h = new LinkHealth({ smoothing: 0.25 });
    let t = 0;
    for (const rtt of [100, 100, 100]) {
      const id = h.pingDue(t)!;
      h.onPong(id, t, t, t + rtt);
      t += 1000;
    }
    const before = h.rttMs!;
    const spike = h.pingDue(t)!;
    h.onPong(spike, t, t, t + 500); // one bad sample
    // Moved towards the spike, nowhere near all the way to it.
    expect(h.rttMs!).toBeGreaterThan(before);
    expect(h.rttMs!).toBeLessThan(250);
  });

  it('notices a wobbling link as jitter, not just as a slow one', () => {
    const steady = new LinkHealth();
    const wobbly = new LinkHealth();
    let t = 0;
    const rtts = [100, 100, 100, 100, 100, 100];
    const spiky = [40, 260, 40, 260, 40, 260];
    for (let i = 0; i < rtts.length; i++) {
      const a = steady.pingDue(t)!;
      steady.onPong(a, t, t, t + rtts[i]!);
      const b = wobbly.pingDue(t)!;
      wobbly.onPong(b, t, t, t + spiky[i]!);
      t += 1000;
    }
    expect(steady.jitterMs).toBeLessThan(5);
    expect(wobbly.jitterMs).toBeGreaterThan(40);
  });

  it('ignores a reply to a ping it never sent', () => {
    const h = new LinkHealth();
    expect(h.onPong(999, 0, 0, 10)).toBeNull();
    expect(h.rttMs).toBeNull();
  });

  it('only answers a given ping once', () => {
    const h = new LinkHealth();
    const id = h.pingDue(0)!;
    expect(h.onPong(id, 0, 0, 100)).not.toBeNull();
    expect(h.onPong(id, 0, 0, 100)).toBeNull();
  });

  it('pings on its own timer rather than on every frame', () => {
    const h = new LinkHealth({ intervalMs: 1000 });
    expect(h.pingDue(0)).not.toBeNull();
    expect(h.pingDue(16)).toBeNull();
    expect(h.pingDue(999)).toBeNull();
    expect(h.pingDue(1000)).not.toBeNull();
  });

  it('does not hoard pings that were never answered', () => {
    const h = new LinkHealth({ intervalMs: 100, lostAfterMs: 500 });
    for (let t = 0; t < 20_000; t += 100) h.pingDue(t);
    expect(h.pendingPings).toBeLessThan(20);
  });
});

describe('calling a link lost', () => {
  it('counts silence from the last thing heard, whatever it was', () => {
    const h = new LinkHealth();
    h.heard(1000);
    expect(h.silentMs(1500)).toBe(500);
    h.heard(2000); // a snapshot, say, rather than a pong
    expect(h.silentMs(2100)).toBe(100);
  });

  it('treats a link that has never spoken as silent, not as fine', () => {
    const h = new LinkHealth();
    expect(h.silentMs(0)).toBe(Infinity);
    expect(h.quality(0)).toBe('lost');
  });

  it('calls a fast, steady link good', () => {
    const h = new LinkHealth();
    let t = 0;
    for (let i = 0; i < 6; i++) {
      const id = h.pingDue(t)!;
      h.onPong(id, t, t, t + 60);
      t += 1000;
    }
    expect(h.quality(t)).toBe('good');
  });

  it('calls a long but steady link fair, because it is playable', () => {
    // Dhaka to Europe is this, and prediction is what makes it ride.
    const h = new LinkHealth();
    let t = 0;
    for (let i = 0; i < 6; i++) {
      const id = h.pingDue(t)!;
      h.onPong(id, t, t, t + 220);
      t += 1000;
    }
    expect(h.quality(t)).toBe('fair');
  });

  it('lets silence outrank a good ping', () => {
    // The failure that started all this: a link that was perfectly healthy
    // right up until it stopped carrying anything, while still claiming to
    // be open.
    const h = new LinkHealth({ lostAfterMs: 2500 });
    const id = h.pingDue(0)!;
    h.onPong(id, 0, 0, 40);
    expect(h.quality(100)).toBe('good');
    expect(h.quality(3000)).toBe('lost');
  });

  it('forgets everything when the link is rebuilt', () => {
    const h = new LinkHealth();
    const id = h.pingDue(0)!;
    h.onPong(id, 0, 0, 100);
    h.reset();
    expect(h.rttMs).toBeNull();
    expect(h.offsetMs).toBeNull();
    expect(h.quality(0)).toBe('lost');
  });
});

import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/world';
import { standingRows } from '../../src/ui/standings';

/** A grid with known places and positions, without running a race to get one. */
function grid(): World {
  const w = new World({ seed: 12 });
  w.racers.forEach((r, i) => {
    r.place = i + 1;
    r.s = 1000 - i * 20;
  });
  return w;
}

describe('the running order', () => {
  it('lists every rider on the grid, in place order', () => {
    const w = grid();
    const rows = standingRows(w.racers, w.localRacer);
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('measures everyone against the rider reading it', () => {
    const w = grid();
    const me = w.racers[2]; // 40 m behind the leader
    w.localRacer = me;
    const rows = standingRows(w.racers, me);

    // Up the road is positive, back down it is negative, and your own row has
    // nothing to say about a gap to yourself.
    expect(rows[0].gap).toBeCloseTo(40);
    expect(rows[2].gap).toBeNull();
    expect(rows[2].isYou).toBe(true);
    expect(rows[3].gap).toBeCloseTo(-20);
    expect(rows.filter((r) => r.isYou)).toHaveLength(1);
  });

  it('marks the rider holding this screen even when it is not racer zero', () => {
    const w = grid();
    // Online the host holds the last seat, and every guest holds another one.
    const me = w.racers[6];
    const rows = standingRows(w.racers, me);
    expect(rows.find((r) => r.isYou)!.name).toBe(me.name);
    expect(rows.find((r) => r.id === 0)!.isYou).toBe(false);
  });

  it('carries the finishing time once a rider is home', () => {
    const w = grid();
    w.racers[0].finishTime = 92.5;
    const rows = standingRows(w.racers, w.localRacer);
    expect(rows[0].finishTime).toBe(92.5);
    expect(rows[1].finishTime).toBeNull();
  });

  it('shows who is off the bike', () => {
    const w = grid();
    w.racers[3].state = 'down';
    w.racers[4].state = 'busted';
    const rows = standingRows(w.racers, w.localRacer);
    expect(rows[3].isDown).toBe(true);
    expect(rows[4].isDown).toBe(true);
    expect(rows[0].isDown).toBe(false);
  });

  it('breaks a tie on the road rather than at random', () => {
    const w = grid();
    // Two riders can share a place for a frame while the host's numbers and
    // ours cross over; the board must not shuffle them about when they do.
    w.racers[1].place = 1;
    w.racers[1].s = w.racers[0].s + 5;
    const rows = standingRows(w.racers, w.localRacer);
    expect(rows[0].id).toBe(w.racers[1].id);
    expect(rows[1].id).toBe(w.racers[0].id);
  });

  it('keeps the bike colours, so a name matches something on the road', () => {
    const w = grid();
    const rows = standingRows(w.racers, w.localRacer);
    expect(rows.map((r) => r.color)).toEqual(
      [...w.racers].sort((a, b) => a.place - b.place).map((r) => r.color),
    );
  });
});

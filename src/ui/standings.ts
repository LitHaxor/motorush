// The running order, as a board can print it.
//
// Pure: it takes the grid and the rider reading it, and hands back rows. No
// DOM, no world - so the thing that decides what "+13 m" means is testable
// under plain Node, and the HUD and the results screen cannot drift apart
// about who is where.

import type { Racer } from '../sim/types';

export interface StandingRow {
  id: number;
  place: number;
  name: string;
  /** Bike colour, so a name on the board matches a bike on the road. */
  color: number;
  /**
   * Metres up the road from you: positive ahead, negative behind.
   *
   * Null for your own row - "you are nought metres from yourself" is noise,
   * and the row is already marked as yours.
   */
  gap: number | null;
  /** Their finishing time once they are home, on the race clock. */
  finishTime: number | null;
  isYou: boolean;
  /** On the tarmac rather than on the bike: down, or taken out of the race. */
  isDown: boolean;
}

/**
 * Order the grid the way it should be read.
 *
 * Sorted by the place each rider has been given rather than re-derived here,
 * because online those places are the host's and the host is the only one
 * entitled to an opinion. Ties are broken by who is further up the road, which
 * is what a place means anyway, so two riders can never swap rows at random
 * while the board is being read.
 */
export function standingRows(racers: readonly Racer[], me: Racer): StandingRow[] {
  return [...racers]
    .sort((a, b) => a.place - b.place || b.s - a.s || a.id - b.id)
    .map((r) => ({
      id: r.id,
      place: r.place,
      name: r.name,
      color: r.color,
      gap: r === me ? null : r.s - me.s,
      finishTime: r.finishTime,
      isYou: r === me,
      isDown: r.state === 'down' || r.state === 'busted',
    }));
}

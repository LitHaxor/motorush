// Where a building is allowed to stand.
//
// One rule, in one place, that every placement goes through: nothing may
// overhang the tarmac. It lives here rather than inside the scenery builder
// because it is arithmetic, not rendering - so it can be tested directly,
// and because the same rule has to hold for the rows beside the road and for
// the blocks on an island between two carriageways.
//
// The whole problem is that buildings are straight and roads are not.

/**
 * How far the ends of a straight block bow away from the centreline.
 *
 * A building is placed tangent to the road at its own midpoint, so on a bend
 * its two ends swing off that tangent. The distance is the sagitta of the
 * chord, `L² / 8R`, and with curvature `k = 1/R` that is `L²k/8`.
 *
 * On a straight it is zero. On a fifty-metre block around a two-hundred-metre
 * radius it is 1.6m, which is the difference between a pavement and a lane.
 */
export function chordBow(length: number, curvature: number): number {
  const k = Math.abs(curvature);
  if (!Number.isFinite(k) || !Number.isFinite(length) || k === 0) return 0;
  return (length * length * k) / 8;
}

/**
 * The longest a straight block can be and still follow the curve.
 *
 * The inverse of `chordBow`: given how far the ends may stray from the arc,
 * how long may the block be. This is how a straight-sided terrace lines a
 * bending road - not by standing further back, which splays the street open
 * where it should be tightest, but by being built in shorter lengths, each
 * one hugging its own piece of the curve. Which is how terraces are actually
 * built.
 */
export function maxChordLength(curvature: number, allowedBow: number): number {
  const k = Math.abs(curvature);
  if (!Number.isFinite(k) || k === 0) return Infinity;
  return Math.sqrt((8 * Math.max(0, allowedBow)) / k);
}

/**
 * How far out a row beside the road has to sit.
 *
 * `edge` is where the tarmac stops and `base` is the setback the street wants.
 * The bow is added rather than hoped about: on the inside of a bend it is the
 * building's ends, not its middle, that reach the kerb first.
 */
export function outerSetback(edge: number, base: number, bow: number): number {
  return edge + base + bow;
}

/**
 * The deepest a block on an island can be without touching either carriageway.
 *
 * Measured across the island, so it is halved from the space available: the
 * island's half-width, less its own pavement, less the bow. Returns zero when
 * there is nothing left worth building on, which the caller reads as "leave
 * this stretch empty".
 */
export function islandDepth(median: number, pavement: number, bow: number): number {
  return Math.max(0, median - pavement - bow) * 2;
}

/**
 * Does this footprint clear the road?
 *
 * The check the other three exist to satisfy, kept separate so a placement can
 * be asserted rather than assumed. `lateral` is the centre of the footprint,
 * `halfDepth` its half-extent across the road, and `bow` what the curve adds
 * to that at the ends.
 */
export function clearsRoad(
  lateral: number,
  halfDepth: number,
  bow: number,
  edge: number,
): boolean {
  return Math.abs(lateral) - halfDepth - bow >= edge;
}

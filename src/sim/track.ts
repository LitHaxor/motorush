// Procedural race track.
//
// The world is described in "track space": `s` is the distance travelled along
// the centreline and `lateral` is the signed offset from it (positive = rider's
// right). The centreline is baked once into flat arrays at construction time and
// linearly interpolated afterwards, which keeps per-frame lookups cheap and,
// more importantly, keeps the whole thing deterministic for a given seed.
//
// Orientation convention (shared with the renderer):
//   forward = (-sin h, 0, -cos h)   right = (cos h, 0, -sin h)
// so a mesh authored facing -Z is aligned with `mesh.rotation.y = heading`.

import { TRACK } from './config';
import { makeRng, clamp } from './mathx';
import type { TrackSample } from './types';
import { blendAt, type BiomeSegment, type DividedSection } from './biomes';

const TWO_PI = Math.PI * 2;

interface WaveTerm {
  amp: number;
  wave: number;
  phase: number;
}

export interface TrackOptions {
  seed?: number;
  length?: number;
  step?: number;
  /** Biome layout, so coast sections can be levelled to a sea. */
  biomes?: readonly BiomeSegment[];
  /**
   * Where the road divides or forks. Decided alongside the biomes (see
   * `buildRoadLayout`) so a split cannot straddle a boundary. Omit for a plain
   * undivided road, which is what tests about handling want.
   */
  divided?: readonly DividedSection[];
}

/** Smooth 0..1 ramp used to keep the start straight so the grid is fair. */
const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

const TMP: TrackSample = { x: 0, y: 0, z: 0, heading: 0, curvature: 0 };

export class Track {
  readonly seed: number;
  readonly step: number;
  readonly length: number;
  readonly halfWidth: number;
  readonly shoulder: number;
  readonly count: number;

  private readonly curveTerms: WaveTerm[];
  private readonly hillTerms: WaveTerm[];

  /** Stretches where a median splits the carriageways. */
  readonly divided: readonly DividedSection[];

  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly zs: Float64Array;
  readonly headings: Float64Array;
  readonly curvatures: Float64Array;

  /** Water surface height for each coast segment, keyed by its start. */
  readonly seaLevels = new Map<number, number>();
  private readonly biomes: readonly BiomeSegment[];

  constructor({
    seed = 1,
    length = TRACK.raceDistance + TRACK.runout,
    step = TRACK.sampleStep,
    biomes = [],
    divided = [],
  }: TrackOptions = {}) {
    const rng = makeRng(seed);
    this.biomes = biomes;
    this.divided = divided;
    this.seed = seed;
    this.step = step;
    this.length = length;
    this.halfWidth = TRACK.halfWidth;
    this.shoulder = TRACK.shoulder;

    // Layered sine curvature: one long sweeping term plus two shorter ones.
    this.curveTerms = [
      { amp: 0.0032, wave: 180 + rng.range(-30, 30), phase: rng() * TWO_PI },
      { amp: 0.0019, wave: 71 + rng.range(-12, 12), phase: rng() * TWO_PI },
      { amp: 0.0012, wave: 33.5 + rng.range(-6, 6), phase: rng() * TWO_PI },
    ];
    this.hillTerms = [
      { amp: 6.0, wave: 230 + rng.range(-40, 40), phase: rng() * TWO_PI },
      { amp: 2.5, wave: 97 + rng.range(-20, 20), phase: rng() * TWO_PI },
    ];

    // A sea has to be flat, so each coast section levels the road out and
    // records the water height to sit below it.
    for (const seg of biomes) {
      if (seg.kind !== 'coast') continue;
      const mid = (seg.from + seg.to) / 2;
      this.seaLevels.set(seg.from, this.rawElevation(mid) - TRACK.coastDrop);
    }

    const count = Math.ceil(length / step) + 2;
    this.count = count;
    this.xs = new Float64Array(count);
    this.ys = new Float64Array(count);
    this.zs = new Float64Array(count);
    this.headings = new Float64Array(count);
    this.curvatures = new Float64Array(count);

    let x = 0;
    let z = 0;
    let heading = 0;
    for (let i = 0; i < count; i++) {
      const s = i * step;
      const c = this.rawCurvature(s);
      this.xs[i] = x;
      this.ys[i] = this.elevation(s);
      this.zs[i] = z;
      this.headings[i] = heading;
      this.curvatures[i] = c;
      // Integrate forward for the next sample.
      heading += c * step;
      x += -Math.sin(heading) * step;
      z += -Math.cos(heading) * step;
    }
  }

  /** Curvature (1/radius) of the centreline at distance `s`. */
  rawCurvature(s: number): number {
    let c = 0;
    for (const t of this.curveTerms) c += t.amp * Math.sin(s / t.wave + t.phase);
    // Hold the first stretch straight for the starting grid.
    return c * smoothstep((s - 40) / 200);
  }

  /** Elevation before any biome levelling. */
  rawElevation(s: number): number {
    let y = 0;
    for (const t of this.hillTerms) y += t.amp * Math.sin(s / t.wave + t.phase);
    return y * smoothstep(s / 120);
  }

  elevation(s: number): number {
    const raw = this.rawElevation(s);
    // Flatten out along the coast so the sea beside it can be level.
    const coast = blendAt(this.biomes, s, 'coast');
    if (coast <= 0) return raw;
    const seg = this.biomes.find(
      (b) => b.kind === 'coast' && s >= b.from - 160 && s <= b.to + 160,
    );
    if (!seg) return raw;
    const level = (this.seaLevels.get(seg.from) ?? raw - TRACK.coastDrop) + TRACK.coastDrop;
    return raw + (level - raw) * coast;
  }

  /** Index + fractional blend for a distance along the track. */
  indexAt(s: number): { i: number; t: number } {
    const clamped = clamp(s, 0, this.length);
    const f = clamped / this.step;
    const i = Math.min(this.count - 2, Math.floor(f));
    return { i, t: f - i };
  }

  /**
   * Interpolated centreline sample. Pass `out` to avoid an allocation.
   *
   * Distances outside the baked range are extrapolated along the end heading
   * rather than clamped - the starting grid sits behind s=0 and the chase
   * camera sits behind that, so collapsing them onto the first sample would
   * stack the whole field on one spot.
   */
  sampleAt(s: number, out: TrackSample = { x: 0, y: 0, z: 0, heading: 0, curvature: 0 }): TrackSample {
    if (s < 0 || s > this.length) {
      const atStart = s < 0;
      const edge = atStart ? 0 : this.count - 1;
      const overshoot = atStart ? s : s - this.length;
      const heading = this.headings[edge];
      // forward = (-sin h, 0, -cos h)
      out.x = this.xs[edge] + -Math.sin(heading) * overshoot;
      out.y = this.ys[edge];
      out.z = this.zs[edge] + -Math.cos(heading) * overshoot;
      out.heading = heading;
      out.curvature = 0;
      return out;
    }
    const { i, t } = this.indexAt(s);
    const j = i + 1;
    out.x = this.xs[i] + (this.xs[j] - this.xs[i]) * t;
    out.y = this.ys[i] + (this.ys[j] - this.ys[i]) * t;
    out.z = this.zs[i] + (this.zs[j] - this.zs[i]) * t;
    out.heading = this.headings[i] + (this.headings[j] - this.headings[i]) * t;
    out.curvature = this.curvatures[i] + (this.curvatures[j] - this.curvatures[i]) * t;
    return out;
  }

  /**
   * Gradient of the road at `s`: positive is uphill, and it is a plain rise
   * over run (0.05 is a 5% climb). Taken from the baked samples so it always
   * matches the geometry the player can see.
   */
  slopeAt(s: number): number {
    const { i } = this.indexAt(s);
    return (this.ys[i + 1] - this.ys[i]) / this.step;
  }

  curvatureAt(s: number): number {
    const { i, t } = this.indexAt(s);
    return this.curvatures[i] + (this.curvatures[i + 1] - this.curvatures[i]) * t;
  }

  headingAt(s: number): number {
    const { i, t } = this.indexAt(s);
    return this.headings[i] + (this.headings[i + 1] - this.headings[i]) * t;
  }

  /** Track space -> world space. */
  toWorld(
    s: number,
    lateral: number,
    out: TrackSample = { x: 0, y: 0, z: 0, heading: 0, curvature: 0 },
  ): TrackSample {
    const p = this.sampleAt(s, TMP);
    const cos = Math.cos(p.heading);
    const sin = Math.sin(p.heading);
    out.x = p.x + cos * lateral;
    out.y = p.y;
    out.z = p.z - sin * lateral;
    out.heading = p.heading;
    out.curvature = p.curvature;
    return out;
  }

  /**
   * Half-width of the central median here, 0 where the road is undivided.
   * Ramped at each end so a divided section opens up gradually rather than
   * a barrier appearing under your wheels.
   */
  medianAt(s: number): number {
    const ramp = TRACK.medianRamp;
    for (const seg of this.divided) {
      if (s < seg.from - ramp || s > seg.to + ramp) continue;
      const into = Math.min(s - (seg.from - ramp), seg.to + ramp - s) / ramp;
      // Ease in and out; a linear ramp makes the island arrive too squarely.
      const t = clamp(into, 0, 1);
      return seg.halfWidth * (t * t * (3 - 2 * t));
    }
    return 0;
  }

  /** True where the split is wide enough to be an island with a route each side. */
  isForkAt(s: number): boolean {
    const ramp = TRACK.medianRamp;
    for (const seg of this.divided) {
      if (s < seg.from - ramp || s > seg.to + ramp) continue;
      return seg.fork;
    }
    return false;
  }

  /**
   * Outer edge of the tarmac. The carriageways move outward around a median,
   * so each keeps its full width however wide the split gets.
   */
  edgeAt(s: number): number {
    return this.halfWidth + this.medianAt(s);
  }

  /** Centre of a traffic lane here, shifted out around any median. */
  laneAt(lane: number, s: number): number {
    const median = this.medianAt(s);
    return lane + Math.sign(lane) * median;
  }

  /** True once the given lateral offset has both wheels off the asphalt. */
  isOffRoad(lateral: number, s = 0): boolean {
    if (Math.abs(lateral) > this.edgeAt(s)) return true;

    // The median is grass, not tarmac - but only once there is actually a
    // strip wide enough to be in. Treating the hairline at the very start of
    // the ramp as grass drops anyone riding the centre line straight to
    // off-road grip, which feels like the bike breaking rather than like
    // running onto a verge.
    const median = this.medianAt(s);
    if (median < TRACK.medianMinEffective) return false;
    return Math.abs(lateral) < median - TRACK.medianForgiveness;
  }

  /**
   * Hard limit: past this you are in the trees / barrier.
   *
   * A fork's island is deliberately NOT included. There is no designed way
   * across, but it is grass rather than a wall - thread the gaps between the
   * trees at off-road speed and you can get to the other carriageway. Paying
   * for it in lost time is a better rule than an invisible barrier.
   */
  isOutOfBounds(lateral: number, s = 0): boolean {
    return Math.abs(lateral) > this.edgeAt(s) + this.shoulder;
  }

  /** Clamp a lateral offset to the drivable + shoulder corridor. */
  clampLateral(lateral: number, s = 0): number {
    const limit = this.edgeAt(s) + this.shoulder;
    const median = this.medianAt(s);
    const clamped = clamp(lateral, -limit, limit);
    // Never leave anyone stranded inside the island; push them to the nearer
    // carriageway.
    if (median > TRACK.medianMinEffective && Math.abs(clamped) < median) {
      return Math.sign(clamped || 1) * (median + 1.5);
    }
    return clamped;
  }
}

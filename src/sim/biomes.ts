// What kind of country the road is passing through.
//
// This lives in the simulation rather than the renderer because terrain
// height, ground cover, props, water and pedestrians all have to agree on
// exactly the same layout, and because it has to be reproducible from a seed.

import type { Rng } from './types';

export type BiomeKind = 'country' | 'city' | 'jungle' | 'hills' | 'coast' | 'paddy';

export interface BiomeSegment {
  from: number;
  to: number;
  kind: BiomeKind;
  /** Coast only: which side of the road the water is on. */
  side: -1 | 0 | 1;
}

interface BiomeSpec {
  kind: BiomeKind;
  weight: number;
  length: [number, number];
}

/** Everything except `country`, which is the default between features. */
const FEATURES: BiomeSpec[] = [
  { kind: 'city', weight: 1.0, length: [340, 640] },
  { kind: 'jungle', weight: 0.9, length: [400, 720] },
  { kind: 'hills', weight: 0.9, length: [420, 780] },
  { kind: 'coast', weight: 0.8, length: [460, 820] },
  { kind: 'paddy', weight: 0.7, length: [320, 560] },
];

export const BIOME = {
  firstAt: [260, 560] as [number, number],
  /** Open country between features. */
  gap: [260, 620] as [number, number],
  /** Slack either side when asking "am I in one?". */
  margin: 25,
  /** Distance over which one biome fades into the next. */
  ramp: 80,
};

function pickFeature(rng: Rng, avoid: BiomeKind | null): BiomeSpec {
  const pool = FEATURES.filter((f) => f.kind !== avoid);
  const total = pool.reduce((a, f) => a + f.weight, 0);
  let roll = rng() * total;
  for (const f of pool) {
    roll -= f.weight;
    if (roll <= 0) return f;
  }
  return pool[pool.length - 1];
}

export function buildBiomes(trackLength: number, rng: Rng): BiomeSegment[] {
  const segments: BiomeSegment[] = [];
  let s = rng.range(BIOME.firstAt[0], BIOME.firstAt[1]);
  let previous: BiomeKind | null = null;

  while (s < trackLength - 260) {
    // Never run the same feature twice in a row - the variety is the point.
    const spec = pickFeature(rng, previous);
    const length = rng.range(spec.length[0], spec.length[1]);
    const to = Math.min(trackLength, s + length);
    segments.push({
      from: s,
      to,
      kind: spec.kind,
      side: spec.kind === 'coast' ? (rng.chance(0.5) ? -1 : 1) : 0,
    });
    previous = spec.kind;
    s = to + rng.range(BIOME.gap[0], BIOME.gap[1]);
  }
  return segments;
}

export function biomeAt(segments: readonly BiomeSegment[], s: number): BiomeKind {
  for (const seg of segments) {
    if (s >= seg.from - BIOME.margin && s <= seg.to + BIOME.margin) return seg.kind;
  }
  return 'country';
}

export function segmentAt(
  segments: readonly BiomeSegment[],
  s: number,
): BiomeSegment | null {
  for (const seg of segments) {
    if (s >= seg.from - BIOME.margin && s <= seg.to + BIOME.margin) return seg;
  }
  return null;
}

/**
 * 0 outside the biome, 1 in the middle of it, ramped at the edges. Used to
 * cross-fade terrain and ground cover instead of switching abruptly.
 */
export function blendAt(
  segments: readonly BiomeSegment[],
  s: number,
  kind: BiomeKind,
  ramp = BIOME.ramp,
): number {
  let best = 0;
  for (const seg of segments) {
    if (seg.kind !== kind) continue;
    if (s < seg.from - ramp || s > seg.to + ramp) continue;
    const into = Math.min(s - (seg.from - ramp), seg.to + ramp - s) / ramp;
    best = Math.max(best, Math.min(1, into));
  }
  return best;
}

/** Which side the sea is on here, and how strongly. -1 left, +1 right. */
export function coastAt(
  segments: readonly BiomeSegment[],
  s: number,
): { side: -1 | 0 | 1; blend: number } {
  for (const seg of segments) {
    if (seg.kind !== 'coast') continue;
    if (s < seg.from - BIOME.ramp || s > seg.to + BIOME.ramp) continue;
    const into = Math.min(s - (seg.from - BIOME.ramp), seg.to + BIOME.ramp - s) / BIOME.ramp;
    return { side: seg.side, blend: Math.max(0, Math.min(1, into)) };
  }
  return { side: 0, blend: 0 };
}

// --------------------------------------------------------------- city shim
// The city was the first biome and a fair amount of code asks about it by
// name; keep those call sites simple.

export interface CitySegment {
  from: number;
  to: number;
}

export const citySegments = (segments: readonly BiomeSegment[]): CitySegment[] =>
  segments.filter((s) => s.kind === 'city').map(({ from, to }) => ({ from, to }));

export const inCity = (segments: readonly BiomeSegment[], s: number): boolean =>
  biomeAt(segments, s) === 'city';

export const cityBlend = (segments: readonly BiomeSegment[], s: number, ramp = 70): number =>
  blendAt(segments, s, 'city', ramp);

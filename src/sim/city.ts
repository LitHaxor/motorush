// Where the built-up stretches are. This lives in the simulation rather than
// the renderer because pedestrians, crossings, buildings and terrain flattening
// all have to agree on exactly the same layout.

import type { Rng } from './types';

export interface CitySegment {
  from: number;
  to: number;
}

export const CITY = {
  firstAt: [320, 700] as [number, number],
  length: [340, 640] as [number, number],
  gap: [480, 1000] as [number, number],
  /** Slack either side used when asking "is this in town?". */
  margin: 25,
};

export function buildCitySegments(trackLength: number, rng: Rng): CitySegment[] {
  const segments: CitySegment[] = [];
  let s = rng.range(CITY.firstAt[0], CITY.firstAt[1]);
  while (s < trackLength - 250) {
    const length = rng.range(CITY.length[0], CITY.length[1]);
    segments.push({ from: s, to: Math.min(trackLength, s + length) });
    s += length + rng.range(CITY.gap[0], CITY.gap[1]);
  }
  return segments;
}

export function inCity(segments: readonly CitySegment[], s: number, margin = CITY.margin): boolean {
  for (const seg of segments) {
    if (s >= seg.from - margin && s <= seg.to + margin) return true;
  }
  return false;
}

/**
 * 0 out in the country, 1 in the middle of town, ramped at the edges. The
 * renderer uses this to flatten the terrain as the buildings close in.
 */
export function cityBlend(segments: readonly CitySegment[], s: number, ramp = 70): number {
  let best = 0;
  for (const seg of segments) {
    if (s < seg.from - ramp || s > seg.to + ramp) continue;
    const into = Math.min(s - (seg.from - ramp), seg.to + ramp - s) / ramp;
    best = Math.max(best, Math.min(1, into));
  }
  return best;
}

// Small math helpers shared by the simulation. Kept dependency-free so the
// whole sim can run headless under Node (see tests/unit).

import type { Rng } from './types';

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Framerate-independent exponential smoothing. `rate` is per-second. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-rate * dt));

/** Move `a` toward `b` by at most `maxDelta`. */
export function approach(a: number, b: number, maxDelta: number): number {
  const d = b - a;
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
}

export const mps2kmh = (v: number): number => v * 3.6;

/**
 * Distance for the end-of-race panel, in kilometres. A race is 7 km, so metres
 * put a four-digit number next to a two-digit one and the row stopped scanning
 * as a set. Two decimals keeps a short bust ("0.18 km") legible without making
 * a full race read as spuriously precise.
 */
export const formatKm = (metres: number): string => {
  const km = Number.isFinite(metres) ? Math.max(0, metres) / 1000 : 0;
  return `${km.toFixed(2)} km`;
};

/**
 * How far ahead or behind somebody is, as the standings board prints it.
 *
 * Signed from the reader's point of view: `+13 m` is thirteen metres up the
 * road, `-30 m` is thirty metres back. Past a kilometre the metre is noise and
 * only gets in the way of reading the number, so it switches to kilometres.
 */
export const formatGap = (metres: number): string => {
  if (!Number.isFinite(metres)) return '';
  const sign = metres >= 0 ? '+' : '-';
  const away = Math.abs(metres);
  if (away < 1000) return `${sign}${Math.round(away)} m`;
  return `${sign}${(away / 1000).toFixed(1)} km`;
};

/**
 * A finishing time short enough to sit in a HUD row.
 *
 * The results board has the room for milliseconds; a line on the standings
 * list does not, and tenths are as fine as anyone reads at a glance anyway.
 */
export function formatShortTime(seconds: number): string {
  let s = seconds;
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const tenths = Math.floor((s * 10) % 10);
  return `${m}:${String(sec).padStart(2, '0')}.${tenths}`;
}

/** Deterministic PRNG (mulberry32) so races are reproducible per seed. */
export function makeRng(seed = 1): Rng {
  let a = seed >>> 0;
  const rng = (() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;

  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.int = (lo, hi) => Math.floor(rng.range(lo, hi + 1));
  rng.pick = <T,>(arr: readonly T[]): T =>
    arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))] as T;
  rng.chance = (p) => rng() < p;
  return rng;
}

/** Format seconds as m:ss.mmm for the timer UI. */
export function formatTime(seconds: number): string {
  let s = seconds;
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s * 1000) % 1000);
  return `${m}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** 1 -> 1ST, 2 -> 2ND ... */
export function ordinal(n: number): string {
  const suffixes = ['TH', 'ST', 'ND', 'RD'] as const;
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]);
}

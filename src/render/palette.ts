// Time-of-day presets. Each race picks one from its seed, so the same seed
// always looks the same.

import * as THREE from 'three';

export interface SkyPreset {
  key: string;
  label: string;
  zenith: number;
  horizon: number;
  haze: number;
  sun: number;
  sunDir: [number, number, number];
  fog: number;
  fogDensity: number;
  ambient: number;
  ambientIntensity: number;
  hemiGround: number;
  sunIntensity: number;
  exposure: number;
  grass: string;
  grassAccent: string;
  cloud: number;
  cloudAmount: number;
}

export const SKY_PRESETS: SkyPreset[] = [
  {
    key: 'goldenhour',
    label: 'GOLDEN HOUR',
    // Sun still above the rim: the rock is lit rather than silhouetted, and
    // the shadows already carry the violet that takes over at dusk.
    zenith: 0x2b3a78,
    horizon: 0xf2a049,
    haze: 0xf0c07e,
    sun: 0xffd49a,
    sunDir: [-0.55, 0.26, -0.8],
    fog: 0xc98a62,
    fogDensity: 0.0016,
    ambient: 0x6a6aa4,
    ambientIntensity: 0.55,
    hemiGround: 0x5a3a2e,
    sunIntensity: 2.7,
    exposure: 1.02,
    grass: '#6b6238',
    grassAccent: '#4f4a29',
    cloud: 0xffcfa0,
    cloudAmount: 0.45,
  },
  {
    key: 'highnoon',
    label: 'HIGH NOON',
    // Same canyon at the top of the day. Warmer ground than a temperate
    // midday, so it still reads as red rock country rather than a meadow.
    zenith: 0x2166cc,
    horizon: 0xb8d2e8,
    haze: 0xe2d6c2,
    sun: 0xfff4de,
    sunDir: [0.3, 0.82, -0.48],
    fog: 0xcfc0ad,
    // Light fog only: the reference has a long, clear view down the canyon.
    fogDensity: 0.0012,
    ambient: 0x9cbde0,
    ambientIntensity: 0.78,
    hemiGround: 0x6b4a33,
    sunIntensity: 3.1,
    exposure: 0.98,
    grass: '#6e7540',
    grassAccent: '#555c31',
    cloud: 0xffffff,
    cloudAmount: 0.55,
  },
  {
    key: 'duskrun',
    label: 'CANYON DUSK',
    // Sampled off the splash painting: indigo overhead, a violet band through
    // the middle, and a narrow gold burn sitting right on the horizon. The
    // warm key against cool fill is what makes the rock read as red rock.
    // Band order matters: the shader lays `haze` right on the horizon, fades
    // up into `horizon`, then into `zenith`. Gold has to be the haze or the
    // whole lower sky goes warm and the indigo never shows.
    zenith: 0x24265c,
    horizon: 0x8a5a8e,
    haze: 0xf0b45c,
    sun: 0xffc27a,
    sunDir: [0.62, 0.1, -0.78],
    fog: 0x6a4f6e,
    // Clear enough to see the far canyon walls, which the old heavy fog ate.
    fogDensity: 0.0015,
    ambient: 0x5a5a96,
    ambientIntensity: 0.62,
    hemiGround: 0x3d2a34,
    sunIntensity: 2.5,
    exposure: 1.06,
    grass: '#5a5236',
    grassAccent: '#423c28',
    cloud: 0xa886b4,
    cloudAmount: 0.5,
  },
];

export function pickSky(seed: number): SkyPreset {
  return SKY_PRESETS[Math.abs(seed) % SKY_PRESETS.length];
}

/** The bright daylight look, used as the default. */
export const DEFAULT_SKY = SKY_PRESETS.find((s) => s.key === 'highnoon') ?? SKY_PRESETS[0];

export const sunVector = (p: SkyPreset): THREE.Vector3 =>
  new THREE.Vector3(...p.sunDir).normalize();

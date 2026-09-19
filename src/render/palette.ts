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
    zenith: 0x1e3a6e,
    horizon: 0xff9a52,
    haze: 0xffc987,
    sun: 0xffd9a0,
    sunDir: [-0.55, 0.22, -0.8],
    fog: 0xf0a866,
    fogDensity: 0.0020,
    ambient: 0x6b7fa8,
    ambientIntensity: 0.55,
    hemiGround: 0x4a3c28,
    sunIntensity: 2.6,
    exposure: 1.05,
    grass: '#5b6135',
    grassAccent: '#454a27',
    cloud: 0xffd2a8,
    cloudAmount: 0.45,
  },
  {
    key: 'highnoon',
    label: 'HIGH NOON',
    zenith: 0x1f66d4,
    horizon: 0xa8d0f0,
    haze: 0xd4e8f8,
    sun: 0xfff8e8,
    sunDir: [0.3, 0.82, -0.48],
    fog: 0xc8def2,
    // Light fog only: the reference has a long, clear view down the road.
    fogDensity: 0.0013,
    ambient: 0x9cc0e4,
    ambientIntensity: 0.8,
    hemiGround: 0x4e7a34,
    sunIntensity: 3.1,
    exposure: 0.98,
    grass: '#4f7a33',
    grassAccent: '#3d6128',
    cloud: 0xffffff,
    cloudAmount: 0.6,
  },
  {
    key: 'duskrun',
    label: 'DUSK RUN',
    zenith: 0x120a2e,
    horizon: 0xd8356b,
    haze: 0x8e3b84,
    sun: 0xff7a5c,
    sunDir: [0.72, 0.13, -0.68],
    fog: 0x6b2a5e,
    fogDensity: 0.0024,
    ambient: 0x4a3f7a,
    ambientIntensity: 0.6,
    hemiGround: 0x2a2036,
    sunIntensity: 2.2,
    exposure: 1.15,
    grass: '#3d4230',
    grassAccent: '#2c3124',
    cloud: 0xff9ec0,
    cloudAmount: 0.55,
  },
];

export function pickSky(seed: number): SkyPreset {
  return SKY_PRESETS[Math.abs(seed) % SKY_PRESETS.length];
}

/** The bright daylight look, used as the default. */
export const DEFAULT_SKY = SKY_PRESETS.find((s) => s.key === 'highnoon') ?? SKY_PRESETS[0];

export const sunVector = (p: SkyPreset): THREE.Vector3 =>
  new THREE.Vector3(...p.sunDir).normalize();

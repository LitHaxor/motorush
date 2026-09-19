// Traffic vehicles. Boxy on purpose - they read clearly at 250 km/h, which is
// the only angle anyone will ever see them from.

import * as THREE from 'three';
import { makeGlowTexture } from './textures';
import type { CarType } from '../sim/types';
import { instantiateScaled, type LoadedModel } from './models';

export interface CarRig {
  root: THREE.Group;
  /** Kept so a recycled car can change colour without rebuilding meshes. */
  bodyMat: THREE.MeshStandardMaterial | null;
  type: CarType;
  headlights: THREE.Sprite[];
  dispose(): void;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g as T;
}

const glassMat = new THREE.MeshStandardMaterial({
  color: 0x121820,
  roughness: 0.08,
  metalness: 0.9,
});
const tyreMat = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.95 });
const trimMat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.7 });
const lampMat = new THREE.MeshStandardMaterial({
  color: 0xfff2d0,
  emissive: 0xfff0c8,
  emissiveIntensity: 1.6,
  toneMapped: false,
});
const tailMat = new THREE.MeshStandardMaterial({
  color: 0x5a0d0d,
  emissive: 0xff2010,
  emissiveIntensity: 1.1,
  toneMapped: false,
});

let glowTex: THREE.Texture | null = null;
const getGlow = (): THREE.Texture => (glowTex ??= makeGlowTexture({ color: '255,240,200' }));

/**
 * Build a vehicle for the given type. Authored facing -Z, same as the bikes,
 * so oncoming cars just get rotated 180 degrees.
 */
/**
 * Kenney's car kit is authored facing +Z; our world drives along -Z, so the
 * imported body gets spun around to match the bikes.
 */
const MODEL_YAW = Math.PI;

/** Build a vehicle from a loaded glTF model, scaled to the sim's dimensions. */
export function createCarFromModel(model: LoadedModel, type: CarType): CarRig {
  const root = new THREE.Group();
  root.name = `car-${type.key}-${model.name}`;

  const body = instantiateScaled(model, {
    length: type.length,
    width: type.width,
    height: type.height,
  });
  body.rotation.y = MODEL_YAW;
  body.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  root.add(body);

  // Kenney bodies have lamps modelled but no glow, so add our own.
  const materials: THREE.Material[] = [];
  const headlights: THREE.Sprite[] = [];
  for (const sx of [-1, 1]) {
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: getGlow(),
        color: 0xfff0cc,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    glow.scale.set(0.66, 0.66, 1);
    glow.position.set(sx * (type.width / 2 - 0.32), type.height * 0.42, -type.length / 2 - 0.05);
    root.add(glow);
    headlights.push(glow);
    materials.push(glow.material);
  }

  return {
    root,
    bodyMat: null,
    type,
    headlights,
    dispose() {
      for (const m of materials) m.dispose();
    },
  };
}

export function createCarMesh(type: CarType, color: number): CarRig {
  const root = new THREE.Group();
  root.name = `car-${type.key}`;
  const { length, width, height } = type;
  const materials: THREE.Material[] = [];

  const bodyMat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.32,
    metalness: 0.45,
    envMapIntensity: 1.1,
  });
  materials.push(bodyMat);

  const tall = type.key === 'van' || type.key === 'truck' || type.key === 'bus';

  // --- body ------------------------------------------------------------
  const bodyH = tall ? height * 0.78 : height * 0.55;
  const body = new THREE.Mesh(
    geo(`body-${type.key}`, () => new THREE.BoxGeometry(width, bodyH, length)),
    bodyMat,
  );
  body.position.y = tall ? bodyH / 2 + 0.38 : bodyH / 2 + 0.34;
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);

  // --- cabin / greenhouse -------------------------------------------------
  if (tall) {
    // Vans and trucks: a windscreen band across the front of the box.
    const screen = new THREE.Mesh(
      geo(`screen-${type.key}`, () => new THREE.BoxGeometry(width * 0.94, bodyH * 0.38, 0.12)),
      glassMat,
    );
    screen.position.set(0, bodyH * 0.72 + 0.38, -length / 2 - 0.01);
    root.add(screen);
  } else {
    const cabinH = height - bodyH - 0.34;
    const cabin = new THREE.Mesh(
      geo(`cabin-${type.key}`, () => new THREE.BoxGeometry(width * 0.88, cabinH, length * 0.46)),
      glassMat,
    );
    cabin.position.set(0, bodyH + cabinH / 2 + 0.34, length * 0.04);
    cabin.castShadow = true;
    root.add(cabin);
  }

  // --- wheels ---------------------------------------------------------------
  const wheelR = tall ? 0.46 : 0.34;
  const wheelGeo = geo(`wheel-${wheelR}`, () => new THREE.CylinderGeometry(wheelR, wheelR, 0.26, 12));
  const axleZ = length * 0.32;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = new THREE.Mesh(wheelGeo, tyreMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(sx * (width / 2 - 0.08), wheelR, sz * axleZ);
      wheel.castShadow = true;
      root.add(wheel);
    }
  }

  // --- bumpers ---------------------------------------------------------------
  const bumperGeo = geo(`bumper-${type.key}`, () => new THREE.BoxGeometry(width * 1.01, 0.22, 0.2));
  for (const sz of [-1, 1]) {
    const bumper = new THREE.Mesh(bumperGeo, trimMat);
    bumper.position.set(0, 0.5, sz * (length / 2));
    root.add(bumper);
  }

  // --- lights -----------------------------------------------------------------
  const lampGeo = geo('lamp', () => new THREE.BoxGeometry(0.28, 0.14, 0.1));
  const headlights: THREE.Sprite[] = [];
  for (const sx of [-1, 1]) {
    const lamp = new THREE.Mesh(lampGeo, lampMat);
    lamp.position.set(sx * (width / 2 - 0.3), bodyH * 0.6 + 0.34, -length / 2 - 0.03);
    root.add(lamp);

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: getGlow(),
        color: 0xfff0cc,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    glow.scale.set(0.62, 0.62, 1);
    glow.position.copy(lamp.position);
    glow.position.z -= 0.1;
    root.add(glow);
    headlights.push(glow);
    materials.push(glow.material);

    const tail = new THREE.Mesh(lampGeo, tailMat);
    tail.position.set(sx * (width / 2 - 0.3), bodyH * 0.6 + 0.34, length / 2 + 0.03);
    root.add(tail);
  }

  return {
    root,
    bodyMat,
    type,
    headlights,
    dispose() {
      for (const m of materials) m.dispose();
    },
  };
}

export function disposeCarGeometry(): void {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
  glowTex?.dispose();
  glowTex = null;
}

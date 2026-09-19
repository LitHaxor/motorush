// Loads the CC0 PBR ground textures (Poly Haven) that ship in public/textures.
//
// Everything here degrades gracefully: if the files cannot be fetched the game
// falls back to the procedural canvas textures and still runs, just flatter.

import * as THREE from 'three';
import { makeRoadTexture, makeGroundTexture, makeDirtTexture } from './textures';

export interface PbrSet {
  map: THREE.Texture;
  normalMap: THREE.Texture | null;
  /** AO/Roughness/Metalness packed into R/G/B. */
  armMap: THREE.Texture | null;
}

export interface GroundTextures {
  asphalt: PbrSet;
  grass: PbrSet;
  gravel: PbrSet;
  /** False when we fell back to the procedural set. */
  pbr: boolean;
  dispose(): void;
}

const BASE = '/textures';

function configure(tex: THREE.Texture, repeat: THREE.Vector2, srgb: boolean, aniso: number): THREE.Texture {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.copy(repeat);
  tex.anisotropy = aniso;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function loadOne(loader: THREE.TextureLoader, url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, () => reject(new Error(`failed to load ${url}`)));
  });
}

async function loadSet(
  loader: THREE.TextureLoader,
  name: string,
  repeat: THREE.Vector2,
  aniso: number,
): Promise<PbrSet> {
  const [map, normalMap, armMap] = await Promise.all([
    loadOne(loader, `${BASE}/${name}_diff.jpg`),
    loadOne(loader, `${BASE}/${name}_nor_gl.jpg`),
    loadOne(loader, `${BASE}/${name}_arm.jpg`),
  ]);
  return {
    map: configure(map, repeat, true, aniso),
    normalMap: configure(normalMap, repeat, false, aniso),
    armMap: configure(armMap, repeat, false, aniso),
  };
}

/** Procedural stand-in so the game never hard-fails on a texture 404. */
function fallback(grass: string, grassAccent: string): GroundTextures {
  const asphalt = makeRoadTexture();
  const grassTex = makeGroundTexture({ base: grass, accent: grassAccent });
  const gravel = makeDirtTexture();
  return {
    asphalt: { map: asphalt, normalMap: null, armMap: null },
    grass: { map: grassTex, normalMap: null, armMap: null },
    gravel: { map: gravel, normalMap: null, armMap: null },
    pbr: false,
    dispose() {
      asphalt.dispose();
      grassTex.dispose();
      gravel.dispose();
    },
  };
}

export async function loadGroundTextures(
  renderer: THREE.WebGLRenderer,
  { grass = '#4a5c33', grassAccent = '#3a4a28' } = {},
): Promise<GroundTextures> {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const loader = new THREE.TextureLoader();
  try {
    const [asphalt, grassSet, gravel] = await Promise.all([
      // Road UVs run 0..1 across the full 18 m width, so repeat to land the
      // asphalt grain at roughly 4 m per tile.
      loadSet(loader, 'asphalt', new THREE.Vector2(4.5, 4.5), aniso),
      loadSet(loader, 'grass', new THREE.Vector2(6, 6), aniso),
      loadSet(loader, 'gravel', new THREE.Vector2(1.5, 6), aniso),
    ]);
    const all = [asphalt, grassSet, gravel];
    return {
      asphalt,
      grass: grassSet,
      gravel,
      pbr: true,
      dispose() {
        for (const set of all) {
          set.map.dispose();
          set.normalMap?.dispose();
          set.armMap?.dispose();
        }
      },
    };
  } catch (err) {
    console.warn('[roadbrush] PBR textures unavailable, using procedural ground', err);
    return fallback(grass, grassAccent);
  }
}

/** Apply a PBR set to a standard material, wiring the packed ARM channels. */
export function applyPbr(
  material: THREE.MeshStandardMaterial,
  set: PbrSet,
  { normalScale = 1, roughness = 1, metalness = 0 } = {},
): THREE.MeshStandardMaterial {
  material.map = set.map;
  if (set.normalMap) {
    material.normalMap = set.normalMap;
    material.normalScale = new THREE.Vector2(normalScale, normalScale);
  }
  if (set.armMap) {
    // Green channel is roughness, blue is metalness - three reads the right
    // one from each slot, so the same texture can serve both.
    material.roughnessMap = set.armMap;
    material.metalnessMap = set.armMap;
  }
  material.roughness = roughness;
  material.metalness = metalness;
  material.needsUpdate = true;
  return material;
}

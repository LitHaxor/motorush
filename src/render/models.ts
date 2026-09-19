// Loads the CC0 glTF props (Kenney kits) and turns them into something the
// renderer can use cheaply: instanced parts for the roadside, clonable groups
// for traffic.
//
// Like the textures, this degrades gracefully - if a model fails to load the
// caller falls back to primitives and the game still runs.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * The roadside roster. Conifers dominate deliberately - they suit the setting
 * and give the long sightlines their vertical rhythm - with broadleaf types
 * mixed in so the verge is not a monoculture.
 */
export const TREE_MODELS = [
  // Conifers
  'tree_pineTallA', 'tree_pineTallB', 'tree_pineTallC', 'tree_pineTallD',
  'tree_pineTallA_detailed', 'tree_pineTallB_detailed',
  'tree_pineTallC_detailed', 'tree_pineTallD_detailed',
  'tree_pineRoundA', 'tree_pineRoundB', 'tree_pineRoundC',
  'tree_pineRoundD', 'tree_pineRoundE', 'tree_pineRoundF',
  'tree_pineDefaultA', 'tree_pineDefaultB',
  'tree_pineGroundA', 'tree_pineGroundB',
  'tree_pineSmallA', 'tree_pineSmallB', 'tree_pineSmallC', 'tree_pineSmallD',
  // Broadleaf
  'tree_default', 'tree_default_dark',
  'tree_detailed', 'tree_detailed_dark',
  'tree_oak', 'tree_oak_dark',
  'tree_tall', 'tree_thin', 'tree_fat', 'tree_simple', 'tree_small', 'tree_cone',
] as const;

/** Index into TREE_MODELS at which the broadleaf types start. */
export const FIRST_BROADLEAF = 22;

export const ROCK_MODELS = ['rock_largeA', 'rock_smallB', 'rock_tallC'] as const;

/** Traffic models, keyed by the sim's CarType.key. */
export const CAR_MODELS: Record<string, string[]> = {
  sedan: ['sedan', 'taxi', 'suv'],
  hatch: ['hatchback-sports', 'sedan'],
  van: ['van', 'delivery'],
  truck: ['truck', 'delivery'],
  bus: ['truck', 'van'],
};

/** One drawable piece of a model, with its transform baked relative to the root. */
export interface ModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrix: THREE.Matrix4;
}

export interface LoadedModel {
  name: string;
  parts: ModelPart[];
  /** Bounding box of the whole model, in its own units. */
  box: THREE.Box3;
  size: THREE.Vector3;
  scene: THREE.Group;
}

export interface ModelLibrary {
  trees: LoadedModel[];
  rocks: LoadedModel[];
  cars: Map<string, LoadedModel>;
  ok: boolean;
  dispose(): void;
}

/** Flatten a glTF scene into parts with world matrices baked in. */
function flatten(root: THREE.Object3D, name: string): LoadedModel {
  const parts: ModelPart[] = [];
  root.updateWorldMatrix(true, true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // A mesh with several materials also has geometry groups; keep them paired.
    if (mats.length === 1) {
      parts.push({
        geometry: mesh.geometry,
        material: mats[0],
        matrix: mesh.matrixWorld.clone(),
      });
    } else {
      mesh.geometry.groups.forEach((g) => {
        const sub = mesh.geometry.clone();
        sub.clearGroups();
        sub.addGroup(g.start, g.count, 0);
        parts.push({
          geometry: sub,
          material: mats[g.materialIndex ?? 0],
          matrix: mesh.matrixWorld.clone(),
        });
      });
    }
  });

  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  return { name, parts, box, size, scene: root as THREE.Group };
}

function load(loader: GLTFLoader, url: string, name: string): Promise<LoadedModel> {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        const model = flatten(gltf.scene, name);
        for (const p of model.parts) {
          const mat = p.material as THREE.MeshStandardMaterial;
          // Kenney kits ship unlit-ish materials; nudge them toward the game's
          // lighting so they sit in the scene properly.
          if (mat.isMeshStandardMaterial) {
            mat.roughness = Math.min(1, (mat.roughness ?? 1) * 0.9 + 0.25);
            mat.metalness = Math.min(mat.metalness ?? 0, 0.15);
            if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
          }
        }
        resolve(model);
      },
      undefined,
      () => reject(new Error(`failed to load ${url}`)),
    );
  });
}

export async function loadModels(): Promise<ModelLibrary> {
  const loader = new GLTFLoader();
  const empty: ModelLibrary = {
    trees: [], rocks: [], cars: new Map(), ok: false, dispose() {},
  };
  try {
    const [trees, rocks, cars] = await Promise.all([
      Promise.all(TREE_MODELS.map((n) => load(loader, `/models/nature/${n}.glb`, n))),
      Promise.all(ROCK_MODELS.map((n) => load(loader, `/models/nature/${n}.glb`, n))),
      (async () => {
        const names = [...new Set(Object.values(CAR_MODELS).flat())];
        const loaded = await Promise.all(names.map((n) => load(loader, `/models/cars/${n}.glb`, n)));
        return new Map(loaded.map((m) => [m.name, m]));
      })(),
    ]);

    const all = [...trees, ...rocks, ...cars.values()];
    return {
      trees,
      rocks,
      cars,
      ok: true,
      dispose() {
        for (const m of all) {
          for (const p of m.parts) {
            p.geometry.dispose();
            p.material.dispose();
          }
        }
      },
    };
  } catch (err) {
    console.warn('[roadbrush] glTF props unavailable, falling back to primitives', err);
    return empty;
  }
}

/**
 * Build one InstancedMesh per part of a model. All instances share the same
 * transform list, so a 6-part tree costs 6 draw calls no matter how many of
 * them are scattered along the track.
 */
export function instanceModel(
  model: LoadedModel,
  transforms: THREE.Matrix4[],
  { castShadow = true, receiveShadow = false } = {},
): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  const combined = new THREE.Matrix4();
  for (const part of model.parts) {
    const inst = new THREE.InstancedMesh(part.geometry, part.material, transforms.length);
    inst.castShadow = castShadow;
    inst.receiveShadow = receiveShadow;
    transforms.forEach((m, i) => {
      // Instance transform first, then the part's own offset within the model.
      combined.multiplyMatrices(m, part.matrix);
      inst.setMatrixAt(i, combined);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false;
    out.push(inst);
  }
  return out;
}

export interface BoxDims {
  length: number;
  width: number;
  height: number;
}

/**
 * How to fit a model to a target bounding box.
 *
 * Two traps here, both of which made the traffic look wrong:
 *
 * 1. Which axis the length runs along is not consistent across asset kits, so
 *    we take the longer horizontal axis and rotate if it was X.
 * 2. Low-poly kits draw stubby cars - Kenney's sedan is 2.55 long by 1.5 wide,
 *    a 1.7:1 ratio, where a real one is nearer 2.5:1. Scaling uniformly by
 *    length therefore inflates the width and height by the same 1.8x and you
 *    get a car taller than the rider. Scaling each axis to the simulation's
 *    own dimensions fixes that, and has the bonus that what you see is exactly
 *    the box you collide with.
 */
export function fitToBox(
  size: { x: number; y: number; z: number },
  target: BoxDims,
): { scale: THREE.Vector3; rotateY: number } {
  const lengthAlongX = size.x > size.z;
  const modelLength = Math.max(0.001, lengthAlongX ? size.x : size.z);
  const modelWidth = Math.max(0.001, lengthAlongX ? size.z : size.x);
  const modelHeight = Math.max(0.001, size.y);

  const alongLength = target.length / modelLength;
  const alongWidth = target.width / modelWidth;
  const alongHeight = target.height / modelHeight;

  // Scale is expressed in the model's own axes, before any rotation.
  const scale = lengthAlongX
    ? new THREE.Vector3(alongLength, alongHeight, alongWidth)
    : new THREE.Vector3(alongWidth, alongHeight, alongLength);

  return { scale, rotateY: lengthAlongX ? Math.PI / 2 : 0 };
}

/** Clone a model into a fresh group, sized to the given bounding box. */
export function instantiateScaled(model: LoadedModel, target: BoxDims): THREE.Group {
  const group = new THREE.Group();
  const { scale, rotateY } = fitToBox(model.size, target);

  const clone = model.scene.clone(true);
  clone.scale.copy(scale);
  // Sit the model on the ground and centre it on its own footprint.
  clone.position.y = -model.box.min.y * scale.y;
  clone.position.x = -((model.box.min.x + model.box.max.x) / 2) * scale.x;
  clone.position.z = -((model.box.min.z + model.box.max.z) / 2) * scale.z;

  // Rotate after centring, so the long axis ends up running down the road.
  const oriented = new THREE.Group();
  oriented.rotation.y = rotateY;
  oriented.add(clone);
  group.add(oriented);
  return group;
}

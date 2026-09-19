// Loads the CC0 glTF props (Kenney kits) and turns them into something the
// renderer can use cheaply: instanced parts for the roadside, clonable groups
// for traffic.
//
// Like the textures, this degrades gracefully - if a model fails to load the
// caller falls back to primitives and the game still runs.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const TREE_MODELS = [
  'tree_pineTallA',
  'tree_pineDefaultA',
  'tree_pineRoundA',
  'tree_default',
  'tree_oak',
  'tree_tall',
] as const;

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

/** Clone a model into a fresh group, scaled so its length matches `targetLength`. */
export function instantiateScaled(model: LoadedModel, targetLength: number): THREE.Group {
  const group = new THREE.Group();
  const clone = model.scene.clone(true);
  const scale = model.size.z > 0.001 ? targetLength / model.size.z : 1;
  clone.scale.setScalar(scale);
  // Sit the model on the ground and centre it on its own footprint.
  clone.position.y = -model.box.min.y * scale;
  clone.position.x = -((model.box.min.x + model.box.max.x) / 2) * scale;
  clone.position.z = -((model.box.min.z + model.box.max.z) / 2) * scale;
  group.add(clone);
  return group;
}

// Everything beside the road: trees, rocks, guardrails, lamp posts, billboards
// and a distant mountain ring. All the dense stuff is instanced, so the whole
// roadside costs a handful of draw calls regardless of track length.

import * as THREE from 'three';
import type { Track } from '../sim/track';
import type { Rng, PickupKind } from '../sim/types';
import type { SkyPreset } from './palette';
import { terrainElevation } from './roadmesh';
import { makeSignTexture } from './textures';
import { instanceModel, type ModelLibrary } from './models';

export interface SceneryHandle {
  group: THREE.Group;
  /** Mountains are re-centred on the camera each frame to fake infinite distance. */
  mountains: THREE.Group;
  dispose(): void;
}

const dummy = new THREE.Object3D();

/** Ground height including the rolling terrain offset. */
function groundAt(track: Track, s: number, lateral: number): THREE.Vector3 {
  const p = track.toWorld(s, lateral);
  return new THREE.Vector3(p.x, p.y + terrainElevation(s, lateral), p.z);
}

export function buildScenery(
  track: Track,
  rng: Rng,
  preset: SkyPreset,
  models: ModelLibrary,
): SceneryHandle {
  const group = new THREE.Group();
  group.name = 'scenery';
  const disposables: { dispose(): void }[] = [];
  const edge = track.halfWidth + track.shoulder;

  // ---------------------------------------------------------------- trees
  const treePlacements: { s: number; lateral: number; scale: number; rot: number }[] = [];
  for (let s = 20; s < track.length; s += rng.range(9, 20)) {
    for (const sign of [-1, 1]) {
      if (rng.chance(0.28)) continue;
      const lateral = sign * rng.range(edge + 3.5, 85);
      treePlacements.push({ s, lateral, scale: rng.range(0.8, 1.5), rot: rng() * Math.PI * 2 });
    }
  }

  const instancedMeshes: THREE.InstancedMesh[] = [];

  if (models.ok && models.trees.length) {
    // Spread placements across the available tree models, then instance each
    // model once for the whole track.
    const buckets: THREE.Matrix4[][] = models.trees.map(() => []);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    treePlacements.forEach((t, i) => {
      const idx = i % models.trees.length;
      const model = models.trees[idx];
      const pos = groundAt(track, t.s, t.lateral);
      // Kenney trees are authored a few units tall; normalise to real height.
      const targetHeight = rng.range(6, 12) * t.scale;
      const unit = model.size.y > 0.001 ? targetHeight / model.size.y : 1;
      v.set(pos.x, pos.y, pos.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot);
      sc.setScalar(unit);
      buckets[idx].push(m4.compose(v, q, sc).clone());
    });
    models.trees.forEach((model, i) => {
      if (!buckets[i].length) return;
      instancedMeshes.push(...instanceModel(model, buckets[i]));
    });
  } else {
    // Primitive fallback: cone on a cylinder.
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 3.2, 6);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.95 });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treePlacements.length);
    trunks.castShadow = true;
    const foliageGeo = new THREE.ConeGeometry(2.1, 6.2, 7);
    const foliageMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(preset.grass).multiplyScalar(1.25),
      roughness: 0.92,
      flatShading: true,
    });
    const foliage = new THREE.InstancedMesh(foliageGeo, foliageMat, treePlacements.length);
    foliage.castShadow = true;
    treePlacements.forEach((t, i) => {
      const pos = groundAt(track, t.s, t.lateral);
      dummy.position.set(pos.x, pos.y + 1.6 * t.scale, pos.z);
      dummy.rotation.set(0, t.rot, 0);
      dummy.scale.setScalar(t.scale);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      dummy.position.y = pos.y + (3.2 + 2.4) * t.scale;
      dummy.updateMatrix();
      foliage.setMatrixAt(i, dummy.matrix);
    });
    trunks.instanceMatrix.needsUpdate = true;
    foliage.instanceMatrix.needsUpdate = true;
    instancedMeshes.push(trunks, foliage);
    disposables.push(trunkGeo, trunkMat, foliageGeo, foliageMat);
  }

  // ---------------------------------------------------------------- rocks
  const rockCount = Math.floor(track.length / 26);
  const rockPlacements: { s: number; lateral: number; scale: number; rot: number }[] = [];
  for (let i = 0; i < rockCount; i++) {
    rockPlacements.push({
      s: rng.range(10, track.length),
      lateral: (rng.chance(0.5) ? -1 : 1) * rng.range(edge + 1.2, 60),
      scale: rng.range(0.7, 2.6),
      rot: rng() * Math.PI * 2,
    });
  }

  if (models.ok && models.rocks.length) {
    const buckets: THREE.Matrix4[][] = models.rocks.map(() => []);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    rockPlacements.forEach((r, i) => {
      const idx = i % models.rocks.length;
      const model = models.rocks[idx];
      const pos = groundAt(track, r.s, r.lateral);
      const unit = model.size.y > 0.001 ? (r.scale * 1.4) / model.size.y : 1;
      v.set(pos.x, pos.y, pos.z);
      q.setFromAxisAngle(up, r.rot);
      sc.setScalar(unit);
      buckets[idx].push(m4.compose(v, q, sc).clone());
    });
    models.rocks.forEach((model, i) => {
      if (!buckets[i].length) return;
      instancedMeshes.push(...instanceModel(model, buckets[i], { receiveShadow: true }));
    });
  } else {
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x6d6a64, roughness: 1, flatShading: true });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockPlacements.length);
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    rockPlacements.forEach((r, i) => {
      const pos = groundAt(track, r.s, r.lateral);
      dummy.position.set(pos.x, pos.y + 0.2, pos.z);
      dummy.rotation.set(r.rot, r.rot * 1.7, r.rot * 0.4);
      dummy.scale.set(r.scale, r.scale * 0.7, r.scale);
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);
    });
    rocks.instanceMatrix.needsUpdate = true;
    instancedMeshes.push(rocks);
    disposables.push(rockGeo, rockMat);
  }

  // ------------------------------------------------------------ guardrails
  // Posts march down both shoulders; they read as a speed reference.
  const postSpacing = 11;
  const postCount = Math.floor(track.length / postSpacing) * 2;
  const postGeo = new THREE.BoxGeometry(0.16, 1.15, 0.16);
  const postMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.5, metalness: 0.65 });
  const posts = new THREE.InstancedMesh(postGeo, postMat, postCount);
  let pi = 0;
  for (let s = 0; s < track.length && pi < postCount; s += postSpacing) {
    for (const sign of [-1, 1]) {
      if (pi >= postCount) break;
      const p = track.toWorld(s, sign * (edge + 0.9));
      dummy.position.set(p.x, p.y + 0.55, p.z);
      dummy.rotation.set(0, p.heading, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      posts.setMatrixAt(pi++, dummy.matrix);
    }
  }
  posts.count = pi;
  posts.instanceMatrix.needsUpdate = true;
  instancedMeshes.push(posts);
  disposables.push(postGeo, postMat);

  // ------------------------------------------------------------ lamp posts
  const lampSpacing = 78;
  const lampCount = Math.floor(track.length / lampSpacing);
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.16, 8.5, 6);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.6, metalness: 0.5 });
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, lampCount);
  poles.castShadow = true;
  const headGeo = new THREE.BoxGeometry(0.5, 0.22, 1.5);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffe9b8,
    emissive: 0xffd98a,
    emissiveIntensity: 0.9,
    toneMapped: false,
  });
  const heads = new THREE.InstancedMesh(headGeo, headMat, lampCount);
  for (let i = 0; i < lampCount; i++) {
    const s = 40 + i * lampSpacing;
    const p = track.toWorld(s, edge + 1.8);
    dummy.position.set(p.x, p.y + 4.25, p.z);
    dummy.rotation.set(0, p.heading, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    poles.setMatrixAt(i, dummy.matrix);

    const head = track.toWorld(s, edge + 0.6);
    dummy.position.set(head.x, p.y + 8.4, head.z);
    dummy.updateMatrix();
    heads.setMatrixAt(i, dummy.matrix);
  }
  poles.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  instancedMeshes.push(poles, heads);
  disposables.push(poleGeo, poleMat, headGeo, headMat);

  // ------------------------------------------------------------ billboards
  const slogans = ['ROADBRUSH', 'NO RULES', 'RIDE OR DIE', 'FULL THROTTLE', 'STAY NASTY'];
  const boardGeo = new THREE.PlaneGeometry(8, 4);
  const legGeo = new THREE.BoxGeometry(0.3, 5, 0.3);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.8 });
  disposables.push(boardGeo, legGeo, legMat);
  for (let s = 420; s < track.length; s += rng.range(500, 900)) {
    const sign = rng.chance(0.5) ? -1 : 1;
    const lateral = sign * rng.range(20, 30);
    const pos = groundAt(track, s, lateral);
    const tex = makeSignTexture(slogans[Math.floor(rng() * slogans.length)]);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, side: THREE.DoubleSide });
    const board = new THREE.Mesh(boardGeo, mat);
    const heading = track.headingAt(s);
    board.position.set(pos.x, pos.y + 6, pos.z);
    // A PlaneGeometry faces +Z; turn its FRONT toward the road or the text
    // reads mirrored from the only angle anyone sees it from.
    board.rotation.y = heading + (sign > 0 ? -Math.PI / 2 : Math.PI / 2);
    board.castShadow = true;
    group.add(board);

    for (const off of [-2.6, 2.6]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(
        pos.x + Math.cos(board.rotation.y) * off,
        pos.y + 2.5,
        pos.z - Math.sin(board.rotation.y) * off,
      );
      group.add(leg);
    }
    disposables.push(mat, tex);
  }

  // ------------------------------------------------------------- mountains
  const mountains = new THREE.Group();
  mountains.name = 'mountains';
  // Enough sides to read as a ridge rather than a pyramid, pushed far enough
  // out that they barely move and sit low on the horizon.
  const mtnGeo = new THREE.ConeGeometry(1, 1, 9);
  const mtnMat = new THREE.MeshBasicMaterial({
    // Almost the haze colour: distant hills should be atmosphere, not objects.
    color: new THREE.Color(preset.haze).lerp(new THREE.Color(preset.fog), 0.6),
    fog: false,
  });
  const ridge = 26;
  for (let i = 0; i < ridge; i++) {
    const a = (i / ridge) * Math.PI * 2 + rng.range(-0.1, 0.1);
    const dist = rng.range(3200, 4300);
    const h = rng.range(150, 380);
    const m = new THREE.Mesh(mtnGeo, mtnMat);
    // Sink the base well below the horizon so only the peaks show.
    m.position.set(Math.cos(a) * dist, h / 2 - 150, Math.sin(a) * dist);
    m.scale.set(rng.range(600, 1100), h, rng.range(600, 1100));
    m.rotation.y = rng() * Math.PI;
    mountains.add(m);
  }
  group.add(mountains);
  disposables.push(mtnGeo, mtnMat);

  group.add(...instancedMeshes);

  return {
    group,
    mountains,
    dispose() {
      for (const d of disposables) d.dispose();
      for (const m of instancedMeshes) m.dispose();
    },
  };
}

// ------------------------------------------------------------------ pickups
const PICKUP_STYLE: Record<PickupKind, { color: number; emissive: number }> = {
  health: { color: 0x25d366, emissive: 0x0f7a38 },
  club: { color: 0xd98b3a, emissive: 0x7a4715 },
  boost: { color: 0x3aa8ff, emissive: 0x0f5c9e },
};

export interface PickupRig {
  root: THREE.Group;
  spin: THREE.Group;
  dispose(): void;
}

/** Floating, spinning crate marking a roadside pickup. */
export function createPickupMesh(kind: PickupKind): PickupRig {
  const style = PICKUP_STYLE[kind];
  const root = new THREE.Group();
  const spin = new THREE.Group();
  root.add(spin);

  const mat = new THREE.MeshStandardMaterial({
    color: style.color,
    emissive: style.emissive,
    emissiveIntensity: 0.8,
    roughness: 0.3,
    metalness: 0.3,
  });
  const geo = new THREE.OctahedronGeometry(0.62, 0);
  const core = new THREE.Mesh(geo, mat);
  core.castShadow = true;
  spin.add(core);

  const ringGeo = new THREE.TorusGeometry(0.95, 0.06, 6, 18);
  const ringMat = new THREE.MeshStandardMaterial({
    color: style.color,
    emissive: style.color,
    emissiveIntensity: 1.2,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  spin.add(ring);

  return {
    root,
    spin,
    dispose() {
      geo.dispose();
      mat.dispose();
      ringGeo.dispose();
      ringMat.dispose();
    },
  };
}

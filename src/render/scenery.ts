// Everything beside the road: trees, rocks, guardrails, lamp posts, billboards
// and a distant mountain ring. All the dense stuff is instanced, so the whole
// roadside costs a handful of draw calls regardless of track length.

import * as THREE from 'three';
import type { Track } from '../sim/track';
import type { Rng, PickupKind } from '../sim/types';
import type { SkyPreset } from './palette';
import { makeTerrainElevation, ribbonGeometry } from './roadmesh';
import {
  makeSignTexture, makeFacadeTexture, makeCheckerTexture, makeZebraTexture, makeBarkTexture,
} from './textures';
import { instanceModel, FIRST_BROADLEAF, type ModelLibrary } from './models';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { inCity, biomeAt, coastAt, type BiomeSegment } from '../sim/biomes';
import type { TreeVariant, TreeSpecies } from './foliage';

export interface SceneryHandle {
  group: THREE.Group;
  /** Mountains are re-centred on the camera each frame to fake infinite distance. */
  mountains: THREE.Group;
  dispose(): void;
}

const dummy = new THREE.Object3D();

/** Ground height at a point, including the rolling terrain offset. */
function groundAt(
  track: Track,
  s: number,
  lateral: number,
  elevate: (s: number, lateral: number) => number,
): THREE.Vector3 {
  const p = track.toWorld(s, lateral);
  return new THREE.Vector3(p.x, p.y + elevate(s, lateral), p.z);
}

export function buildScenery(
  track: Track,
  rng: Rng,
  preset: SkyPreset,
  models: ModelLibrary,
  biomes: readonly BiomeSegment[],
  treeVariants: readonly TreeVariant[] = [],
  grassTuft: TreeVariant | null = null,
): SceneryHandle {
  const group = new THREE.Group();
  group.name = 'scenery';
  const disposables: { dispose(): void }[] = [];
  // Widest the road ever gets, so nothing is planted where a fork will open.
  const maxMedian = track.divided.reduce((m, d) => Math.max(m, d.halfWidth), 0);
  const edge = track.halfWidth + track.shoulder + maxMedian;
  const edgeAt = (s: number) => track.edgeAt(s) + track.shoulder;
  const elevate = makeTerrainElevation(biomes);

  // ---------------------------------------------------------------- trees
  // What grows where. Each biome draws from its own list of species, which is
  // most of what makes one stretch of road feel different from the next.
  const SPECIES_BY_BIOME: Record<string, TreeSpecies[]> = {
    country: ['conifer', 'conifer', 'broadleaf', 'oak', 'maple', 'bush'],
    hills: ['conifer', 'conifer', 'conifer', 'bush'],
    jungle: ['jungle', 'jungle', 'jungle', 'broadleaf', 'bush', 'bush'],
    coast: ['broadleaf', 'oak', 'bush', 'bush'],
    paddy: ['bush', 'broadleaf'],
    city: ['oak', 'maple', 'bush'],
    // High ground: conifers thinning out as the walls climb.
    mountain: ['conifer', 'conifer', 'conifer', 'bush'],
    // Hedgerows and orchard trees around the houses.
    village: ['oak', 'maple', 'broadleaf', 'bush', 'bush'],
  };

  /** How thickly trees are planted, and how far back from the road. */
  const DENSITY_BY_BIOME: Record<string, { skip: number; reach: number; height: [number, number] }> = {
    country: { skip: 0.18, reach: 100, height: [8, 21] },
    hills: { skip: 0.1, reach: 130, height: [9, 24] },
    jungle: { skip: 0.02, reach: 70, height: [10, 26] },
    coast: { skip: 0.55, reach: 45, height: [9, 17] },
    paddy: { skip: 0.82, reach: 60, height: [5, 11] },
    city: { skip: 0.85, reach: 0, height: [5, 8] },
    mountain: { skip: 0.3, reach: 150, height: [7, 18] },
    village: { skip: 0.55, reach: 75, height: [6, 14] },
  };

  const bySpecies = new Map<TreeSpecies, number[]>();
  treeVariants.forEach((v, i) => {
    const list = bySpecies.get(v.species) ?? [];
    list.push(i);
    bySpecies.set(v.species, list);
  });

  interface TreeSpot { s: number; lateral: number; height: number; rot: number; kind: number; tint: number }
  const treePlacements: TreeSpot[] = [];

  if (treeVariants.length) {
    for (let s = 20; s < track.length; s += rng.range(6, 13)) {
      const biome = biomeAt(biomes, s);
      const density = DENSITY_BY_BIOME[biome] ?? DENSITY_BY_BIOME.country;
      const species = SPECIES_BY_BIOME[biome] ?? SPECIES_BY_BIOME.country;
      const urban = biome === 'city';
      const sea = coastAt(biomes, s);

      for (const sign of [-1, 1]) {
        if (rng.chance(density.skip)) continue;
        // Nothing grows out in the water.
        if (sea.blend > 0.4 && sign === sea.side) continue;

        const here = edgeAt(s);
        const distance = urban || density.reach <= 0
          ? rng.range(here + 6, here + 9)
          : rng.range(here + 2, Math.max(here + 6, density.reach));

        const pick = species[Math.floor(rng() * species.length)];
        const pool = bySpecies.get(pick) ?? bySpecies.get('broadleaf') ?? [0];
        const kind = pool[Math.floor(rng() * pool.length)];
        const variant = treeVariants[kind];
        // Bushes are shrubs, whatever biome they are in.
        const range: [number, number] = variant.species === 'bush'
          ? [1.4, 3.2]
          : density.height;

        // Keep the canopy off the carriageway. A tree's crown spreads with its
        // height, so one planted close to the verge has to be a small one -
        // which is also how roadside planting actually looks.
        const clearance = Math.max(0, distance - here - 0.5);
        const maxHeight = clearance / Math.max(0.05, variant.radius * 0.85);
        const height = Math.min(rng.range(range[0], range[1]), maxHeight);
        if (height < range[0] * 0.45) continue;

        treePlacements.push({
          s,
          lateral: sign * distance,
          height,
          rot: rng() * Math.PI * 2,
          // Subtle per-tree tint so no two neighbours match exactly.
          tint: rng.range(0.78, 1.12),
          kind,
        });
      }
    }
  }

  // ------------------------------------------------------------- islands
  // A fork's island is planted, which is what makes it read as something you
  // cannot cut across rather than a wide grass median.
  if (treeVariants.length) {
    for (const seg of track.divided) {
      if (!seg.fork) continue;
      for (let s = seg.from + 12; s < seg.to - 12; s += rng.range(7, 16)) {
        const median = track.medianAt(s);
        if (median < 4) continue;
        // In town the island is a city block, handled with the buildings.
        if (biomeAt(biomes, s) === 'city') continue;
        const pick = rng.chance(0.45) ? 'bush' : biomeAt(biomes, s) === 'jungle' ? 'jungle' : 'conifer';
        const pool = bySpecies.get(pick as TreeSpecies) ?? bySpecies.get('bush') ?? [0];
        const kind = pool[Math.floor(rng() * pool.length)];
        const variant = treeVariants[kind];
        // Fit the crown inside the island so it does not hang over a lane.
        const room = median - 1.2;
        if (room <= 0.5) continue;
        const height = Math.min(
          variant.species === 'bush' ? rng.range(1.4, 3) : rng.range(6, 14),
          room / Math.max(0.05, variant.radius * 0.9),
        );
        if (height < 1) continue;
        treePlacements.push({
          s,
          lateral: rng.range(-room * 0.55, room * 0.55),
          height,
          rot: rng() * Math.PI * 2,
          tint: rng.range(0.8, 1.1),
          kind,
        });
      }
    }
  }

  const instancedMeshes: THREE.InstancedMesh[] = [];

  if (treeVariants.length && treePlacements.length) {
    const buckets: TreeSpot[][] = treeVariants.map(() => []);
    for (const spot of treePlacements) buckets[Math.min(spot.kind, treeVariants.length - 1)].push(spot);

    const tintColour = new THREE.Color();
    const barkTex = makeBarkTexture();
    const barkMat = new THREE.MeshStandardMaterial({ map: barkTex, roughness: 0.95 });
    const trunkGeo = new THREE.CylinderGeometry(0.018, 0.038, 1, 6, 1, true);
    trunkGeo.translate(0, 0.5, 0);
    disposables.push(barkTex, barkMat, trunkGeo);

    // Trunks for everything except the shrubs, in one instanced draw.
    const trunked = treePlacements.filter((sp) => treeVariants[sp.kind].species !== 'bush');
    if (trunked.length) {
      const trunks = new THREE.InstancedMesh(trunkGeo, barkMat, trunked.length);
      trunks.castShadow = true;
      trunks.frustumCulled = false;
      trunked.forEach((spot, i) => {
        const pos = groundAt(track, spot.s, spot.lateral, elevate);
        dummy.position.copy(pos);
        dummy.rotation.set(0, spot.rot, 0);
        // Palms have tall bare trunks; the rest are mostly hidden by canopy.
        const slim = 1;
        dummy.scale.set(spot.height * slim, spot.height, spot.height * slim);
        dummy.updateMatrix();
        trunks.setMatrixAt(i, dummy.matrix);
      });
      trunks.instanceMatrix.needsUpdate = true;
      instancedMeshes.push(trunks);
    }

    treeVariants.forEach((variant, vi) => {
      const spots = buckets[vi];
      if (!spots.length) return;

      const mat = new THREE.MeshStandardMaterial({
        map: variant.texture,
        alphaTest: 0.4,
        side: THREE.FrontSide,
        roughness: 0.95,
        metalness: 0,
      });

      const mesh = new THREE.InstancedMesh(variant.geometry, mat, spots.length);
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      spots.forEach((spot, i) => {
        const pos = groundAt(track, spot.s, spot.lateral, elevate);
        dummy.position.copy(pos);
        dummy.rotation.set(0, spot.rot, 0);
        dummy.scale.setScalar(spot.height);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        tintColour.setRGB(spot.tint * 0.96, spot.tint, spot.tint * 0.9);
        mesh.setColorAt(i, tintColour);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      instancedMeshes.push(mesh);
      disposables.push(variant.geometry, mat, variant.texture);
    });
  }

  // ----------------------------------------------------------------- turf
  // Ground texture alone reads as painted on at speed; actual blades catching
  // the light beside the road are what sell it.
  if (grassTuft) {
    const tufts: { s: number; lateral: number; size: number; rot: number; tint: number }[] = [];
    for (let s = 10; s < track.length; s += rng.range(1.6, 4.2)) {
      const biome = biomeAt(biomes, s);
      if (biome === 'city') continue;
      const sea = coastAt(biomes, s);
      const lush = biome === 'jungle' || biome === 'paddy' ? 3 : 1;
      for (let i = 0; i < lush; i++) {
        const sign = rng.chance(0.5) ? -1 : 1;
        if (sea.blend > 0.4 && sign === sea.side) continue;
        tufts.push({
          s: s + rng.range(-1.5, 1.5),
          // Thickest right at the verge, thinning out away from the road.
          lateral: sign * (edge + 0.4 + Math.pow(rng(), 1.7) * 26),
          size: rng.range(0.5, 1.3),
          rot: rng() * Math.PI,
          tint: rng.range(0.7, 1.15),
        });
      }
    }

    const mat = new THREE.MeshStandardMaterial({
      map: grassTuft.texture,
      alphaTest: 0.38,
      side: THREE.FrontSide,
      roughness: 1,
      metalness: 0,
    });
    const mesh = new THREE.InstancedMesh(grassTuft.geometry, mat, tufts.length);
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    const tintColour = new THREE.Color();
    tufts.forEach((tuft, i) => {
      const pos = groundAt(track, tuft.s, tuft.lateral, elevate);
      dummy.position.copy(pos);
      dummy.rotation.set(0, tuft.rot, 0);
      dummy.scale.setScalar(tuft.size);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      tintColour.setRGB(tuft.tint * 0.92, tuft.tint, tuft.tint * 0.78);
      mesh.setColorAt(i, tintColour);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    instancedMeshes.push(mesh);
    disposables.push(grassTuft.geometry, mat, grassTuft.texture);
  }

  // ---------------------------------------------------------------- rocks
  const rockCount = Math.floor(track.length / 26);
  const rockPlacements: { s: number; lateral: number; scale: number; rot: number }[] = [];
  for (let i = 0; i < rockCount; i++) {
    const s = rng.range(10, track.length);
    if (inCity(biomes, s)) continue;
    rockPlacements.push({
      s,
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
      const pos = groundAt(track, r.s, r.lateral, elevate);
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
      const pos = groundAt(track, r.s, r.lateral, elevate);
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
  const postSpacing = 4;
  const postCount = Math.floor(track.length / postSpacing) * 2;
  const postGeo = new THREE.BoxGeometry(0.14, 1.0, 0.14);
  const postMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.5, metalness: 0.65 });
  const posts = new THREE.InstancedMesh(postGeo, postMat, postCount);
  let pi = 0;
  for (let s = 0; s < track.length && pi < postCount; s += postSpacing) {
    for (const sign of [-1, 1]) {
      if (pi >= postCount) break;
      // Same line as the guardrail beam in roadmesh.ts.
      const p = track.toWorld(s, sign * edge);
      dummy.position.set(p.x, p.y + 0.42, p.z);
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

  // -------------------------------------------------------------- buildings
  // City blocks: a handful of facade prototypes, each instanced along the
  // built-up stretches so a whole downtown costs a few draw calls.
  const PROTOTYPES = [
    { w: 16, d: 14, h: 11, floors: 3, bays: 4, wall: '#7a6a5c', trim: '#4a3f36' },
    { w: 20, d: 16, h: 18, floors: 5, bays: 5, wall: '#5f6670', trim: '#3a4048' },
    { w: 14, d: 18, h: 26, floors: 8, bays: 3, wall: '#8a7264', trim: '#544339' },
    { w: 24, d: 20, h: 15, floors: 4, bays: 6, wall: '#6b5f6e', trim: '#403845' },
    { w: 18, d: 15, h: 34, floors: 11, bays: 4, wall: '#55606b', trim: '#343c45' },
  ];

  const buildingSlots: THREE.Matrix4[][] = PROTOTYPES.map(() => []);
  const bm = new THREE.Matrix4();
  const bq = new THREE.Quaternion();
  const bv = new THREE.Vector3();
  const bs = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  // A fork running through town splits around a block of buildings, not a
  // stand of trees.
  for (const fork of track.divided) {
    if (!fork.fork) continue;
    let s = fork.from + 20;
    while (s < fork.to - 20) {
      if (biomeAt(biomes, s) !== 'city') {
        s += 20;
        continue;
      }
      const median = track.medianAt(s);
      const idx = rng.int(0, PROTOTYPES.length - 1);
      const proto = PROTOTYPES[idx];
      // Only what actually fits between the carriageways.
      const room = (median - 1.5) * 2;
      if (room < 8) {
        s += 20;
        continue;
      }
      const jitter = Math.min(rng.range(0.85, 1.15), room / proto.w, room / proto.d);
      const width = proto.w * jitter;
      const at = track.toWorld(s + width / 2, 0);
      bv.set(at.x, at.y + (proto.h * jitter) / 2 - 0.4, at.z);
      bq.setFromAxisAngle(up, at.heading);
      bs.set(jitter, jitter, jitter);
      buildingSlots[idx].push(bm.compose(bv, bq, bs).clone());
      s += width + rng.range(2, 7);
    }
  }

  for (const seg of biomes) {
    // Buildings belong to the city, not to every biome.
    if (seg.kind !== 'city') continue;
    for (const sign of [-1, 1]) {
      // Walk the block, packing buildings shoulder to shoulder along the kerb.
      let s = seg.from;
      while (s < seg.to) {
        const idx = rng.int(0, PROTOTYPES.length - 1);
        const proto = PROTOTYPES[idx];
        const jitter = rng.range(0.85, 1.2);
        const width = proto.w * jitter;
        const setback = edgeAt(s) + 3.5 + rng.range(0, 3);
        const at = track.toWorld(s + width / 2, sign * (setback + proto.d / 2));
        bv.set(at.x, at.y + (proto.h * jitter) / 2 - 0.4, at.z);
        bq.setFromAxisAngle(up, at.heading);
        bs.set(jitter, jitter, jitter);
        buildingSlots[idx].push(bm.compose(bv, bq, bs).clone());
        s += width + rng.range(1.5, 6);
      }
    }
  }

  PROTOTYPES.forEach((proto, i) => {
    const slots = buildingSlots[i];
    if (!slots.length) return;
    const tex = makeFacadeTexture({
      floors: proto.floors,
      bays: proto.bays,
      wall: proto.wall,
      trim: proto.trim,
      litChance: preset.key === 'duskrun' ? 0.6 : 0.2,
    });
    // One tile across the width, one up the height.
    tex.repeat.set(1, 1);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.88, metalness: 0.02 });
    const geo = new THREE.BoxGeometry(proto.w, proto.h, proto.d);
    const mesh = new THREE.InstancedMesh(geo, mat, slots.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    slots.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    instancedMeshes.push(mesh);
    disposables.push(geo, mat, tex);
  });

  // --------------------------------------------------------------- village
  // A handful of houses and a barn set back behind their gardens - scattered,
  // not packed shoulder to shoulder the way a city block is.
  const villages = biomes.filter((b) => b.kind === 'village');
  if (villages.length) {
    const HOUSES = [
      { w: 7, d: 6, h: 4.2, roof: 2.6, wall: '#c9bda8', trim: '#6d6251', roofColour: 0x8a4032 },
      { w: 9, d: 7, h: 5.4, roof: 3.2, wall: '#d6cdbb', trim: '#5f574a', roofColour: 0x6d4a3a },
      { w: 11, d: 8, h: 6, roof: 3.6, wall: '#b6a893', trim: '#544c40', roofColour: 0x4a4a52 },
      { w: 4.5, d: 4, h: 2.9, roof: 1.8, wall: '#c2b6a2', trim: '#5c5447', roofColour: 0x5a4a3e },
    ];

    const wallSlots: THREE.Matrix4[][] = HOUSES.map(() => []);
    const roofSlots: THREE.Matrix4[][] = HOUSES.map(() => []);
    const hm = new THREE.Matrix4();
    const hq = new THREE.Quaternion();
    const hv = new THREE.Vector3();
    const hs = new THREE.Vector3();
    const hup = new THREE.Vector3(0, 1, 0);

    for (const seg of villages) {
      for (const sign of [-1, 1]) {
        let s = seg.from + rng.range(10, 40);
        while (s < seg.to - 20) {
          const idx = rng.int(0, HOUSES.length - 1);
          const house = HOUSES[idx];
          const scale = rng.range(0.85, 1.2);
          const setback = edgeAt(s) + rng.range(7, 22);
          const pos = groundAt(track, s, sign * setback, elevate);
          // Turned roughly toward the road, but not regimented.
          const facing = track.headingAt(s) + (sign > 0 ? Math.PI / 2 : -Math.PI / 2)
            + rng.range(-0.35, 0.35);

          hq.setFromAxisAngle(hup, facing);
          hs.setScalar(scale);
          hv.set(pos.x, pos.y + (house.h * scale) / 2, pos.z);
          wallSlots[idx].push(hm.compose(hv, hq, hs).clone());
          hv.set(pos.x, pos.y + (house.h + house.roof * 0.5) * scale, pos.z);
          roofSlots[idx].push(hm.compose(hv, hq, hs).clone());

          s += house.w * scale + rng.range(14, 46);
        }
      }
    }

    HOUSES.forEach((house, i) => {
      if (!wallSlots[i].length) return;
      const tex = makeFacadeTexture({
        floors: house.h > 5 ? 2 : 1,
        bays: 3,
        wall: house.wall,
        trim: house.trim,
        litChance: preset.key === 'duskrun' ? 0.55 : 0.12,
      });
      const wallMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
      const wallGeo = new THREE.BoxGeometry(house.w, house.h, house.d);
      const walls = new THREE.InstancedMesh(wallGeo, wallMat, wallSlots[i].length);
      walls.castShadow = true;
      walls.receiveShadow = true;
      wallSlots[i].forEach((m, k) => walls.setMatrixAt(k, m));
      walls.instanceMatrix.needsUpdate = true;
      walls.frustumCulled = false;
      instancedMeshes.push(walls);

      // Hipped roof: a four-sided pyramid sitting on the walls.
      const roofMat = new THREE.MeshStandardMaterial({ color: house.roofColour, roughness: 0.85 });
      const roofGeo = new THREE.ConeGeometry(Math.max(house.w, house.d) * 0.78, house.roof, 4);
      roofGeo.rotateY(Math.PI / 4);
      const roofs = new THREE.InstancedMesh(roofGeo, roofMat, roofSlots[i].length);
      roofs.castShadow = true;
      roofSlots[i].forEach((m, k) => roofs.setMatrixAt(k, m));
      roofs.instanceMatrix.needsUpdate = true;
      roofs.frustumCulled = false;
      instancedMeshes.push(roofs);

      disposables.push(wallGeo, wallMat, tex, roofGeo, roofMat);
    });
  }

  // ------------------------------------------------------------ billboards
  const slogans = ['ROADBRUSH', 'NO RULES', 'RIDE OR DIE', 'FULL THROTTLE', 'STAY NASTY'];
  const boardGeo = new THREE.PlaneGeometry(8, 4);
  const legGeo = new THREE.BoxGeometry(0.3, 5, 0.3);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.8 });
  disposables.push(boardGeo, legGeo, legMat);
  for (let s = 420; s < track.length; s += rng.range(500, 900)) {
    if (inCity(biomes, s)) continue;
    const sign = rng.chance(0.5) ? -1 : 1;
    const lateral = sign * rng.range(20, 30);
    const pos = groundAt(track, s, lateral, elevate);
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

// ---------------------------------------------------------------- people
export interface PedestrianRig {
  root: THREE.Group;
  body: THREE.Group;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  dispose(): void;
}

const SKIN = [0xf0c9a0, 0xd9a878, 0xa9754f, 0x7a4f31, 0x5a3820] as const;

/** A person: torso, head, two legs, two arms. Enough to read at speed. */
export function createPedestrianMesh(colour: number, kind: string, seed = 0): PedestrianRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const materials: THREE.Material[] = [];
  const mat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };

  const shirt = mat(new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85 }));
  const trousers = mat(new THREE.MeshStandardMaterial({ color: 0x2d3340, roughness: 0.9 }));
  const skin = mat(new THREE.MeshStandardMaterial({
    color: SKIN[Math.abs(seed) % SKIN.length],
    roughness: 0.75,
  }));

  const torsoGeo = new THREE.BoxGeometry(0.42, 0.56, 0.24);
  const torso = new THREE.Mesh(torsoGeo, shirt);
  torso.position.y = 1.06;
  torso.castShadow = true;
  body.add(torso);

  const headGeo = new THREE.SphereGeometry(0.135, 10, 8);
  const head = new THREE.Mesh(headGeo, skin);
  head.position.y = 1.46;
  head.castShadow = true;
  body.add(head);

  const legGeo = new THREE.BoxGeometry(0.15, 0.78, 0.17);
  const legL = new THREE.Mesh(legGeo, trousers);
  legL.position.set(-0.11, 0.39, 0);
  legL.castShadow = true;
  const legR = legL.clone();
  legR.position.x = 0.11;
  body.add(legL, legR);

  const armGeo = new THREE.BoxGeometry(0.11, 0.5, 0.13);
  const armL = new THREE.Mesh(armGeo, shirt);
  // Pivot at the shoulder so rotation swings the arm properly.
  armL.geometry.translate(0, -0.25, 0);
  armL.position.set(-0.27, 1.3, 0);
  const armR = armL.clone();
  armR.position.x = 0.27;
  body.add(armL, armR);

  const geos: THREE.BufferGeometry[] = [torsoGeo, headGeo, legGeo, armGeo];

  // The start marshal waves a checkered flag.
  if (kind === 'marshal') {
    const poleGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6);
    const pole = new THREE.Mesh(poleGeo, mat(new THREE.MeshStandardMaterial({ color: 0x6b5233 })));
    pole.position.set(0, 0.5, 0);
    pole.rotation.z = -0.5;
    armR.add(pole);

    const flagTex = makeCheckerTexture({ squares: 6 });
    const flagGeo = new THREE.PlaneGeometry(0.7, 0.5);
    const flag = new THREE.Mesh(
      flagGeo,
      mat(new THREE.MeshStandardMaterial({ map: flagTex, side: THREE.DoubleSide, roughness: 0.9 })),
    );
    flag.position.set(0.34, 1.2, 0);
    pole.add(flag);
    geos.push(poleGeo, flagGeo);
    // CanvasTexture is not a Material, so dispose it alongside the geometry.
    geos.push({ dispose: () => flagTex.dispose() } as unknown as THREE.BufferGeometry);
  }

  return {
    root,
    body,
    legL,
    legR,
    armL,
    armR,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

// ------------------------------------------------------------- crossings
/** Zebra stripes and signal posts at each city crossing. */
export function buildCrossings(
  track: Track,
  crossings: readonly { s: number }[],
): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group();
  group.name = 'crossings';
  if (!crossings.length) return { group, dispose() {} };

  const zebraTex = makeZebraTexture();
  const zebraMat = new THREE.MeshBasicMaterial({
    map: zebraTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -6,
  });

  const half = track.halfWidth;
  const geos: THREE.BufferGeometry[] = [];
  const postGeo = new THREE.BoxGeometry(0.13, 2.7, 0.13);
  const headGeo = new THREE.BoxGeometry(0.26, 0.6, 0.22);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x33383f, roughness: 0.7, metalness: 0.4 });
  const redMat = new THREE.MeshStandardMaterial({
    color: 0xff3b30, emissive: 0xff2a20, emissiveIntensity: 1.4, toneMapped: false,
  });

  for (const crossing of crossings) {
    const geo = ribbonGeometry(
      track,
      [{ lateral: -half, u: 0 }, { lateral: half, u: 1 }],
      3.2,
      () => 0.018,
      1.6,
      crossing.s,
      crossing.s + 3.2,
    );
    const stripes = new THREE.Mesh(geo, zebraMat);
    stripes.renderOrder = 2;
    group.add(stripes);
    geos.push(geo);

    for (const sign of [-1, 1]) {
      const at = track.toWorld(crossing.s, sign * (half + 1.4));
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(at.x, at.y + 1.35, at.z);
      post.rotation.y = at.heading;
      post.castShadow = true;
      group.add(post);

      const lamp = new THREE.Mesh(headGeo, redMat);
      lamp.position.set(at.x, at.y + 2.75, at.z);
      lamp.rotation.y = at.heading;
      group.add(lamp);
    }
  }

  return {
    group,
    dispose() {
      for (const g of geos) g.dispose();
      postGeo.dispose();
      headGeo.dispose();
      postMat.dispose();
      redMat.dispose();
      zebraMat.dispose();
      zebraTex.dispose();
    },
  };
}

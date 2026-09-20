// Everything beside the road: trees, rocks, guardrails, lamp posts, billboards
// and a distant mountain ring. All the dense stuff is instanced, so the whole
// roadside costs a handful of draw calls regardless of track length.

import * as THREE from 'three';
import type { Track } from '../sim/track';
import { CITY } from '../sim/config';
import type { Rng, PickupKind } from '../sim/types';
import type { SkyPreset } from './palette';
import { makeTerrainElevation, ribbonGeometry, START_RUNUP, type Band } from './roadmesh';
import {
  makeSignTexture, makeFacadeTexture, makeWindowLightsTexture, makeCheckerTexture,
  makeZebraTexture, makeBarkTexture,
} from './textures';
import { instanceModel, FIRST_BROADLEAF, type ModelLibrary } from './models';
import type { FacadeSet, FacadeTextures } from './assets';
import type { Obstacle } from '../sim/obstacles';
import { makeRng } from '../sim/mathx';
import { chordBow, islandDepth, maxChordLength } from './siting';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { inCity, biomeAt, coastAt, type BiomeSegment } from '../sim/biomes';
import type { TreeVariant, TreeSpecies } from './foliage';

export interface SceneryHandle {
  group: THREE.Group;
  /** Mountains are re-centred on the camera each frame to fake infinite distance. */
  mountains: THREE.Group;
  /**
   * Hide the scenery chunks the fog has already swallowed. Frustum culling
   * alone will not do it: the view is a long thin cone, so a tree four
   * kilometres up the road sits squarely inside it and draws in full.
   */
  cull(cameraX: number, cameraZ: number, radius: number): void;
  dispose(): void;
}

/**
 * How far you can see before the fog has finished the job, for a given
 * FogExp2 density. Three weights fog by exp(-(density * depth)^2), so at
 * 2.6 / density the far side is 99.9% fog and nothing behind it can matter.
 * Capped so the clearest preset does not simply switch culling off.
 */
export const cullRadius = (fogDensity: number): number =>
  Math.min(2000, 2.6 / fogDensity);

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

/**
 * How wide a scenery chunk is, in metres. Small enough that most of the course
 * falls outside the frustum, big enough not to bury the driver in draw calls.
 */
const CHUNK = 200;

/**
 * Split an instanced mesh into a grid of smaller ones so the frustum can throw
 * most of them away.
 *
 * An InstancedMesh gets a single bounding sphere covering every instance it
 * holds, so one mesh carrying the whole course's trees has a sphere kilometres
 * across. It intersects the frustum wherever you happen to be standing, and
 * three.js then draws it in full - every tree on the track, every frame,
 * including the ones behind you and the ones four kilometres up the road.
 * Bucketing the instances by world position gives each chunk a tight sphere,
 * and the ones you cannot see cost nothing in either the main pass or the
 * shadow pass.
 */
function chunkInstances(mesh: THREE.InstancedMesh): THREE.InstancedMesh[] {
  if (mesh.count <= 8) return [mesh];

  const m = new THREE.Matrix4();
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    // elements[12] and [14] are the translation's x and z.
    const key = `${Math.floor(m.elements[12] / CHUNK)},${Math.floor(m.elements[14] / CHUNK)}`;
    const found = buckets.get(key);
    if (found) found.push(i);
    else buckets.set(key, [i]);
  }
  if (buckets.size < 2) return [mesh];

  const colour = mesh.instanceColor;
  const c = new THREE.Color();
  const out: THREE.InstancedMesh[] = [];
  for (const indices of buckets.values()) {
    // Geometry and material are shared with the original, so a chunk costs
    // nothing but its own instance buffers.
    const chunk = new THREE.InstancedMesh(mesh.geometry, mesh.material, indices.length);
    chunk.name = mesh.name;
    chunk.castShadow = mesh.castShadow;
    chunk.receiveShadow = mesh.receiveShadow;
    if (colour) {
      chunk.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(indices.length * 3), 3,
      );
    }
    indices.forEach((src, k) => {
      mesh.getMatrixAt(src, m);
      chunk.setMatrixAt(k, m);
      if (colour) {
        c.fromBufferAttribute(colour, src);
        chunk.setColorAt(k, c);
      }
    });
    chunk.instanceMatrix.needsUpdate = true;
    if (chunk.instanceColor) chunk.instanceColor.needsUpdate = true;
    chunk.computeBoundingSphere();
    out.push(chunk);
  }
  return out;
}


/**
 * Keeps scenery's randomness clear of the simulation's.
 *
 * Scenery used to draw from the world's own generator, which meant the
 * renderer could shift the simulation's random sequence simply by drawing a
 * different number of numbers - and it did, because half of it sits behind
 * `if (asset.loaded)`. A rider whose foliage failed to load got different
 * buildings from everybody else in the room.
 */
const SCENERY_SALT = 0x51ce;
/** Tree *appearance* draws from here, so a missing atlas cannot move a wall. */
const FOLIAGE_SALT = 0xf01a;

export function buildScenery(
  track: Track,
  seed: number,
  preset: SkyPreset,
  models: ModelLibrary,
  biomes: readonly BiomeSegment[],
  treeVariants: readonly TreeVariant[] = [],
  grassTuft: TreeVariant | null = null,
  /** Photographed building fronts. Empty means the drawn ones are used. */
  facades: FacadeTextures = { sets: [], pbr: false, dispose() {} },
  /** Where the simulation says the trees are. Drawn, not decided, here. */
  obstacles: readonly Obstacle[] = [],
): SceneryHandle {
  const rng: Rng = makeRng((seed ^ SCENERY_SALT) >>> 0);
  // Appearance only - species, tint, which way a trunk faces. Positions and
  // heights belong to the simulation, because they are what you hit.
  const foliageRng: Rng = makeRng((seed ^ FOLIAGE_SALT) >>> 0);
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

  /*
   * The wood, as the simulation planted it.
   *
   * Positions and heights are not decided here any more. They are what a rider
   * collides with, so they belong to the simulation - which grows them from
   * the room's seed on a stream of its own, so every browser in a race has the
   * identical trees in the identical places. All that is left here is what a
   * tree looks like: which species, which way round, and how it is tinted.
   */
  if (treeVariants.length) {
    for (const o of obstacles) {
      const biome = biomeAt(biomes, o.s);
      const species = o.onIsland
        ? (foliageRng.chance(0.45) ? ['bush'] : biome === 'jungle' ? ['jungle'] : ['conifer'])
        : (SPECIES_BY_BIOME[biome] ?? SPECIES_BY_BIOME.country);
      const pick = species[Math.floor(foliageRng() * species.length)] as TreeSpecies;
      const pool = bySpecies.get(pick) ?? bySpecies.get('broadleaf') ?? [0];
      const kind = pool[Math.floor(foliageRng() * pool.length)];
      treePlacements.push({
        s: o.s,
        lateral: o.lateral,
        height: o.height,
        rot: foliageRng() * Math.PI * 2,
        // Subtle per-tree tint so no two neighbours match exactly.
        tint: foliageRng.range(0.78, 1.12),
        kind,
      });
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
    for (let s = -START_RUNUP; s < track.length; s += rng.range(1.6, 4.2)) {
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
  const postCount = Math.floor((track.length + START_RUNUP) / postSpacing) * 2 + 4;
  const postGeo = new THREE.BoxGeometry(0.14, 1.0, 0.14);
  const postMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.5, metalness: 0.65 });
  const posts = new THREE.InstancedMesh(postGeo, postMat, postCount);
  let pi = 0;
  for (let s = -START_RUNUP; s < track.length && pi < postCount; s += postSpacing) {
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
    // Per-post, not the global `edge`. That constant folds in the widest
    // median anywhere on the track, so on the undivided majority of the road
    // every lamp stood nine metres out in a field.
    const roadEdge = edgeAt(s);
    const p = track.toWorld(s, roadEdge + 1.8);
    dummy.position.set(p.x, p.y + 4.25, p.z);
    dummy.rotation.set(0, p.heading, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    poles.setMatrixAt(i, dummy.matrix);

    const head = track.toWorld(s, roadEdge + 0.6);
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
  /**
   * The city's stock of buildings.
   *
   * Fourteen rather than five, because a block built from five shapes is
   * read as a repeat within about two hundred metres. They cost almost
   * nothing: each is one instanced draw call however many of it are standing,
   * and they share three photographs between them.
   *
   * `facade` picks which photograph, and it is chosen by width rather than by
   * taste. A tile of the tower front carries fourteen windows across, so on a
   * fourteen-metre building each window comes out a metre wide and the thing
   * reads as a filing cabinet - that front only goes on the wide blocks.
   * `tint` multiplies the photograph, which is what turns three images into
   * fourteen buildings: the same brick, weathered differently.
   */
  const PROTOTYPES = [
    // --- brick terraces and mid-rise: the everyday street wall -------------
    { w: 16, d: 14, h: 11, floors: 3, bays: 4, wall: '#7a6a5c', trim: '#4a3f36', facade: 0, tint: 0xffffff },
    { w: 19, d: 15, h: 14, floors: 4, bays: 5, wall: '#7a6a5c', trim: '#4a3f36', facade: 0, tint: 0xf0ebe3 },
    { w: 14, d: 17, h: 19, floors: 6, bays: 4, wall: '#8a7264', trim: '#544339', facade: 0, tint: 0xe6dbcd },
    { w: 22, d: 18, h: 16, floors: 5, bays: 6, wall: '#6b5f6e', trim: '#403845', facade: 0, tint: 0xdccec1 },
    { w: 17, d: 16, h: 24, floors: 8, bays: 4, wall: '#8a7264', trim: '#544339', facade: 0, tint: 0xf6f2ea },
    // --- offices: darker, squarer, taller ---------------------------------
    { w: 20, d: 16, h: 18, floors: 5, bays: 5, wall: '#5f6670', trim: '#3a4048', facade: 1, tint: 0xffffff },
    { w: 18, d: 18, h: 27, floors: 8, bays: 5, wall: '#55606b', trim: '#343c45', facade: 1, tint: 0xe8ecf0 },
    { w: 24, d: 20, h: 21, floors: 6, bays: 6, wall: '#6b5f6e', trim: '#403845', facade: 1, tint: 0xdbe0e6 },
    { w: 16, d: 19, h: 33, floors: 10, bays: 4, wall: '#55606b', trim: '#343c45', facade: 1, tint: 0xf0f3f6 },
    { w: 21, d: 17, h: 41, floors: 13, bays: 5, wall: '#4f5a66', trim: '#2f363e', facade: 1, tint: 0xeef1f4 },
    // --- the wide ones, where a curtain wall is the right size ------------
    { w: 38, d: 22, h: 30, floors: 9, bays: 12, wall: '#5f6670', trim: '#3a4048', facade: 2, tint: 0xffffff },
    { w: 44, d: 24, h: 44, floors: 14, bays: 14, wall: '#4f5a66', trim: '#2f363e', facade: 2, tint: 0xeef1f4 },
    { w: 34, d: 26, h: 56, floors: 18, bays: 11, wall: '#55606b', trim: '#343c45', facade: 2, tint: 0xe2e7ec },
    { w: 40, d: 20, h: 23, floors: 7, bays: 13, wall: '#6b5f6e', trim: '#403845', facade: 2, tint: 0xf7f8fa },
  ];

  const buildingSlots: THREE.Matrix4[][] = PROTOTYPES.map(() => []);
  const bm = new THREE.Matrix4();
  const bq = new THREE.Quaternion();
  const bv = new THREE.Vector3();
  const bs = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  /*
   * The island between two carriageways, built on as a block of city.
   *
   * One loop for every island, fork or median alike. There used to be two -
   * one for forks and one for anything wide enough - and they ran over the
   * same ground, so a fork island got two rows of buildings standing inside
   * each other. The second of them also took no account of the curve, which
   * is how a block ended up in a live carriageway.
   */
  for (const seg of track.divided) {
    let s = seg.from + 10;
    // Where this island actually opened up, so its nose can be left clear.
    let openedAt: number | null = null;
    while (s < seg.to - 10) {
      const median = track.medianAt(s);
      // Needs to be a real island, in town, with room for something to stand on.
      if (median < CITY.islandMinHalfWidth || biomeAt(biomes, s) !== 'city') {
        openedAt = null;
        s += 12;
        continue;
      }
      openedAt ??= s;
      /*
       * Nothing on the nose of the island.
       *
       * A rider meeting a split head-on sees whatever stands on it dead ahead,
       * and on a bend it stays dead ahead while the lane curves away - which
       * reads as a wall across the road rather than as a fork to pick a side
       * of. Leaving the first stretch as bare kerb gives the split somewhere
       * to be read from before there is anything solid in the way.
       */
      if (s - openedAt < ISLAND_NOSE_CLEAR) {
        s += 12;
        continue;
      }
      const idx = rng.int(0, PROTOTYPES.length - 1);
      const proto = PROTOTYPES[idx];
      const curve = track.toWorld(s, 0).curvature;
      const longest = maxChordLength(curve, FOLLOW_BOW);
      const alongScale = Math.max(0.35, Math.min(rng.range(0.8, 1.1), longest / proto.w));
      const width = proto.w * alongScale;
      // The one rule: pavement off, then the bow of the curve off, and what
      // is left is what may be built on.
      const bow = chordBow(width, curve);
      const buildable = islandDepth(median, CITY.islandPavement + 0.4, bow);
      if (buildable < 6) {
        s += 12;
        continue;
      }
      // Per axis, so squashing a block to fit a narrow island does not squash
      // its height too and leave a row of stumps down the middle of the road.
      const tallScale = rng.range(0.85, 1.15);
      const acrossScale = Math.min(1, buildable / proto.d);
      const at = track.toWorld(s + width / 2, 0);
      bv.set(at.x, at.y + (proto.h * tallScale) / 2 - 0.4, at.z);
      // Turned a quarter, so the block's LENGTH runs along the road.
      //
      // A box is built w x h x d, so its local X is `w` - but rotating it by
      // the road's heading alone points local Z down the road, which laid every
      // building across the carriageway like a sleeper. Everything else here
      // reckons in `w` along and `d` across, so this is the rotation that makes
      // the rest of the arithmetic true.
      bq.setFromAxisAngle(up, at.heading + Math.PI / 2);
      bs.set(alongScale, tallScale, acrossScale);
      buildingSlots[idx].push(bm.compose(bv, bq, bs).clone());
      s += width + rng.range(3, 9);
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
        // Cut to a length that follows the bend rather than cutting across it.
        // Height is left alone: a short building is a narrow one, not a stunted
        // one, and a terrace of narrow houses around a corner is exactly right.
        const curve = track.toWorld(s, 0).curvature;
        const longest = maxChordLength(curve, FOLLOW_BOW);
        const lengthScale = Math.max(0.35, Math.min(rng.range(0.85, 1.2), longest / proto.w));
        const tallScale = rng.range(0.9, 1.15);
        const width = proto.w * lengthScale;
        // Measured from the tarmac edge with the same constant the pavement
        // uses, so the two always meet instead of leaving a strip of grass.
        // A constant setback, because the length above already keeps the ends
        // on the building line. Pushing the row outward on bends instead made
        // the street splay open exactly where a city should feel tightest.
        const setback = track.edgeAt(s) + CITY.buildingSetback
          + rng.range(0, CITY.buildingJitter) + chordBow(width, curve);
        const at = track.toWorld(s + width / 2, sign * (setback + proto.d / 2));
        bv.set(at.x, at.y + (proto.h * tallScale) / 2 - 0.4, at.z);
        // See the island block above: a quarter turn puts `w` along the road.
        bq.setFromAxisAngle(up, at.heading + Math.PI / 2);
        bs.set(lengthScale, tallScale, 1);
        buildingSlots[idx].push(bm.compose(bv, bq, bs).clone());
        s += width + rng.range(1.5, 6);
      }
    }
  }

  // Nobody has the lights on at midday. The old drawn facades got away with
  // it because their windows were painted on; a photographed building with
  // glowing panes in full sun just looks broken.
  const litChance = preset.key === 'duskrun' ? 0.34 : preset.key === 'goldenhour' ? 0.14 : 0;
  const lightsAt = preset.key === 'duskrun' ? 0.72 : preset.key === 'goldenhour' ? 0.3 : 0;

  PROTOTYPES.forEach((proto, i) => {
    const slots = buildingSlots[i];
    if (!slots.length) return;
    const geo = new THREE.BoxGeometry(proto.w, proto.h, proto.d);
    // Photographed fronts if they loaded, drawn ones if they did not. The
    // drawn city is the fallback rather than the plan, but it is a working
    // city, which is the whole point of having one.
    const facade = facades.sets[proto.facade] ?? null;
    const mat = facade
      ? dressWithPhoto(geo, proto, facade, litChance, lightsAt, disposables)
      : dressWithCanvas(proto, litChance, disposables);

    const mesh = new THREE.InstancedMesh(geo, mat, slots.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    slots.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    instancedMeshes.push(mesh);
    disposables.push(geo, mat);
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
  const slogans = ['MOTORUSH', 'NO RULES', 'RIDE OR DIE', 'FULL THROTTLE', 'STAY NASTY'];
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

  // Chunk last, once every instance is placed: the whole point is a tight
  // bounding sphere per chunk, which needs the final positions.
  const chunked = instancedMeshes.flatMap(chunkInstances);
  group.add(...chunked);

  // Cached so the per-frame cull is a flat loop over numbers, not a traverse.
  const spheres = chunked.map((m) => {
    if (!m.boundingSphere) m.computeBoundingSphere();
    return m.boundingSphere!;
  });

  return {
    group,
    mountains,
    cull(cameraX: number, cameraZ: number, radius: number) {
      for (let i = 0; i < chunked.length; i++) {
        const c = spheres[i].center;
        const dx = c.x - cameraX;
        const dz = c.z - cameraZ;
        // Compare squared distances, and let the chunk's own radius extend its
        // reach so nothing pops while part of it is still in the clear.
        const reach = radius + spheres[i].radius;
        chunked[i].visible = dx * dx + dz * dz <= reach * reach;
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
      for (const m of instancedMeshes) m.dispose();
      for (const m of chunked) m.dispose();
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

/**
 * A building wearing a photograph.
 *
 * The tiling is baked into the geometry's UVs rather than into the texture,
 * because every prototype shares the one loaded texture and a repeat set on it
 * would be a repeat set on all of them. Scaling the UVs lets each building
 * carry its own number of storeys off the same image.
 */
function dressWithPhoto(
  geo: THREE.BoxGeometry,
  proto: { w: number; h: number; d: number; tint: number },
  facade: FacadeSet,
  litChance: number,
  lightsAt: number,
  disposables: { dispose(): void }[],
): THREE.MeshStandardMaterial {
  // Whole tiles only: half a tile cuts a row of windows in two at the corner.
  // Height rounds up rather than to nearest, because too few storeys stretches
  // a window into a letterbox, and nobody reads a tower as tall when its
  // windows are four metres high.
  const tilesX = Math.max(1, Math.round(proto.w / facade.tileWidth));
  const tilesY = Math.max(1, Math.ceil(proto.h / facade.tileHeight));

  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let k = 0; k < uv.count; k++) {
    uv.setXY(k, uv.getX(k) * tilesX, uv.getY(k) * tilesY);
  }
  uv.needsUpdate = true;

  // One set of lights for the whole building rather than one per tile, so the
  // same few windows are not lit on every floor. It is wound back down by the
  // repeat, which cancels the UV scaling above exactly. Skipped outright in
  // daylight rather than drawn black - a texture nobody can see is still a
  // texture the card has to hold.
  let lights: THREE.CanvasTexture | null = null;
  if (litChance > 0) {
    lights = makeWindowLightsTexture({
      cols: tilesX * facade.bays,
      rows: tilesY * facade.floors,
      litChance,
    });
    lights.repeat.set(1 / tilesX, 1 / tilesY);
    disposables.push(lights);
  }

  const mat = new THREE.MeshStandardMaterial({
    // Multiplies the photograph, so one image dresses several buildings.
    color: new THREE.Color(proto.tint),
    map: facade.map,
    normalMap: facade.normalMap ?? undefined,
    roughnessMap: facade.armMap ?? undefined,
    roughness: 1,
    metalness: 0,
    emissive: new THREE.Color(0xffffff),
    emissiveMap: lights ?? undefined,
    // Held below 1 on purpose. The renderer tone maps with ACES, which pushes
    // anything bright towards white - at full strength every lit window came
    // out the same cold white and the warmth drawn into the map was thrown
    // away. Backed off, the colour survives the curve.
    emissiveIntensity: lightsAt,
  });
  return mat;
}

/** The drawn city: what gets built when the photographs are not there. */
function dressWithCanvas(
  proto: { floors: number; bays: number; wall: string; trim: string },
  litChance: number,
  disposables: { dispose(): void }[],
): THREE.MeshStandardMaterial {
  const tex = makeFacadeTexture({
    floors: proto.floors,
    bays: proto.bays,
    wall: proto.wall,
    trim: proto.trim,
    // The drawn windows are their own light source, so they are lit harder.
    litChance: litChance > 0.3 ? 0.6 : 0.2,
  });
  // One tile across the width, one up the height.
  tex.repeat.set(1, 1);
  disposables.push(tex);
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.88, metalness: 0.02 });
}

/**
 * How much of an island's leading end is left as bare kerb.
 *
 * A rider meeting a split head-on sees whatever stands on it dead ahead, and
 * on a bend it stays dead ahead while the lane curves away - which reads as a
 * wall across the road rather than as a fork to pick a side of. At 65 m/s this
 * is a second and a half of open island before anything solid is on it, which
 * is the time it takes to read the split and commit to a side.
 */
const ISLAND_NOSE_CLEAR = 95;

/**
 * How far a block's ends may stray from the curve it is lining, in metres.
 *
 * Small on purpose. This is what decides how short buildings get on a bend,
 * and therefore whether a terrace reads as following the road or as a row of
 * planks laid across it.
 */
const FOLLOW_BOW = 0.35;

// ---------------------------------------------------------------- people
export interface PedestrianRig {
  root: THREE.Group;
  body: THREE.Group;
  /** Thighs and upper arms, pivoting at hip and shoulder. */
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  /** Lower halves, hung off the joint above them. */
  shinL: THREE.Mesh;
  shinR: THREE.Mesh;
  forearmL: THREE.Mesh;
  forearmR: THREE.Mesh;
  /** Where this person is in their own stride. Theirs alone, and integrated. */
  phase: number;
  dispose(): void;
}

/** Where the joints sit, measured up from the pavement. */
const HIP_Y = 0.78;
const THIGH = 0.42;
const SHIN = 0.36;
const SHOULDER_Y = 1.3;
const UPPER_ARM = 0.28;
const FOREARM = 0.24;

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

  // Legs in two pieces, each hung from the joint above it.
  //
  // The pivot is the whole point. A leg used to be one box positioned at its
  // own centre, so swinging it rotated about knee height: the foot went
  // forward and the top of the thigh went backwards through the hip. That is
  // what made the crowd look like scissors rather than people. Translating
  // the geometry up puts the origin at the joint, exactly as the arms below
  // have always done.
  const thighGeo = new THREE.BoxGeometry(0.15, THIGH, 0.17);
  thighGeo.translate(0, -THIGH / 2, 0);
  const legL = new THREE.Mesh(thighGeo, trousers);
  legL.position.set(-0.11, HIP_Y, 0);
  legL.castShadow = true;

  const shinGeo = new THREE.BoxGeometry(0.14, SHIN, 0.16);
  shinGeo.translate(0, -SHIN / 2, 0);
  const shinL = new THREE.Mesh(shinGeo, trousers);
  shinL.position.y = -THIGH;
  shinL.castShadow = true;
  legL.add(shinL);

  const legR = legL.clone(true);
  legR.position.x = 0.11;
  const shinR = legR.children[0] as THREE.Mesh;
  body.add(legL, legR);

  const armGeo = new THREE.BoxGeometry(0.11, UPPER_ARM, 0.13);
  // Pivot at the shoulder so rotation swings the arm properly.
  armGeo.translate(0, -UPPER_ARM / 2, 0);
  const armL = new THREE.Mesh(armGeo, shirt);
  armL.position.set(-0.27, SHOULDER_Y, 0);

  const forearmGeo = new THREE.BoxGeometry(0.10, FOREARM, 0.12);
  forearmGeo.translate(0, -FOREARM / 2, 0);
  const forearmL = new THREE.Mesh(forearmGeo, skin);
  forearmL.position.y = -UPPER_ARM;
  armL.add(forearmL);

  const armR = armL.clone(true);
  armR.position.x = 0.27;
  const forearmR = armR.children[0] as THREE.Mesh;
  body.add(armL, armR);

  const geos: THREE.BufferGeometry[] = [
    torsoGeo, headGeo, thighGeo, shinGeo, armGeo, forearmGeo,
  ];

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
    shinL,
    shinR,
    forearmL,
    forearmR,
    phase: 0,
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
  // Lit, like the rest of the road paint - unlit white stripes glow at dusk.
  const zebraMat = new THREE.MeshStandardMaterial({
    map: zebraTex,
    roughness: 0.75,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -6,
  });

  // Deliberately not `track.halfWidth`: that is the width of ONE carriageway,
  // and where the road splits it painted the crossing from -9 to +9 - which is
  // the island, not the road. A crossing is laid over whatever tarmac is
  // actually there, which on a divided street is two separate stretches of it.

  const geos: THREE.BufferGeometry[] = [];
  const postGeo = new THREE.BoxGeometry(0.13, 2.7, 0.13);
  const headGeo = new THREE.BoxGeometry(0.26, 0.6, 0.22);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x33383f, roughness: 0.7, metalness: 0.4 });
  const redMat = new THREE.MeshStandardMaterial({
    color: 0xff3b30, emissive: 0xff2a20, emissiveIntensity: 1.4, toneMapped: false,
  });

  for (const crossing of crossings) {
    // One ribbon per side. With no median the two meet on the centreline and
    // read as a single crossing; with one they stop at the island's kerb and
    // start again on its far side, which is what a crossing over a divided
    // street looks like.
    const sides: Band[][] = [
      [
        { lateral: (x: number) => -track.edgeAt(x), u: 0 },
        { lateral: (x: number) => -track.medianAt(x), u: 1 },
      ],
      [
        { lateral: (x: number) => track.medianAt(x), u: 0 },
        { lateral: (x: number) => track.edgeAt(x), u: 1 },
      ],
    ];
    const geo = mergeGeometries(sides.map((bands) => ribbonGeometry(
      track,
      bands,
      3.2,
      () => 0.018,
      1.6,
      crossing.s,
      crossing.s + CITY.crossingLength,
    )));
    const stripes = new THREE.Mesh(geo, zebraMat);
    stripes.renderOrder = 2;
    group.add(stripes);
    geos.push(geo);

    for (const sign of [-1, 1]) {
      // On the pavement, not on the tarmac. At half + 1.4 the post stood at
      // 10.4m with the barrier out at 13.5, so signals were planted in the
      // carriageway riders were still using.
      const at = track.toWorld(
        crossing.s,
        sign * (track.edgeAt(crossing.s) + CITY.walkway[0]),
      );
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

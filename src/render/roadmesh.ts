// Track geometry: asphalt, gravel shoulders and rolling terrain, all generated
// as ribbons that follow the centreline so they hug every crest and corner.

import * as THREE from 'three';
import type { Track } from '../sim/track';
import type { SkyPreset } from './palette';
import { makeMarkingsTexture, makeCheckerTexture, makeGuardrailTexture } from './textures';
import { applyPbr, type GroundTextures } from './assets';
import { cityBlend, type CitySegment } from '../sim/city';

export interface Band {
  lateral: number;
  u: number;
}

export type ElevateFn = (s: number, lateral: number) => number;

/**
 * Build a strip that follows the track. `bands` are lateral offsets across the
 * strip; `vScale` is how many metres of track one texture tile covers.
 */
export function ribbonGeometry(
  track: Track,
  bands: Band[],
  vScale: number,
  elevate?: ElevateFn,
  step = track.step,
  fromS = 0,
  toS = track.length,
): THREE.BufferGeometry {
  const rows = Math.max(2, Math.ceil((toS - fromS) / step) + 1);
  const cols = bands.length;
  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const indices: number[] = [];
  const p = { x: 0, y: 0, z: 0, heading: 0, curvature: 0 };

  for (let r = 0; r < rows; r++) {
    const s = Math.min(toS, fromS + r * step);
    for (let c = 0; c < cols; c++) {
      const band = bands[c];
      track.toWorld(s, band.lateral, p);
      const i = (r * cols + c) * 3;
      positions[i] = p.x;
      positions[i + 1] = p.y + (elevate ? elevate(s, band.lateral) : 0);
      positions[i + 2] = p.z;
      const j = (r * cols + c) * 2;
      uvs[j] = band.u;
      uvs[j + 1] = s / vScale;
    }
  }

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      // Counter-clockwise when viewed from above, so the face normals point up.
      // Get this backwards and the whole road is back-face culled.
      indices.push(a, b, d, b, e, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Rolling hills that grow the further you get from the tarmac. Squaring the
 * falloff keeps the verge beside the road flat and rideable while letting the
 * landscape climb properly further out.
 */
export const terrainElevation: ElevateFn = (s, lateral) => {
  // Stay well clear of the road: the verge beside the tarmac is flat, and the
  // landscape only starts to lift further out.
  const d = Math.max(0, Math.abs(lateral) - 16);
  const falloff = Math.min(1, d / 45);
  const along =
    Math.sin(s * 0.0041 + 2.1) * 7 +
    Math.sin(s * 0.0165) * 2.2 +
    Math.sin(s * 0.0092 + 1.3) * 1.6;
  // Vary across the track too, or the hills read as parallel walls.
  const across = Math.sin(lateral * 0.0075) * 6 + Math.sin(lateral * 0.021 + s * 0.0033) * 2.5;
  return (along + across) * falloff * falloff;
};

/** Terrain that is flattened out wherever the city has been built. */
export function makeTerrainElevation(city: readonly CitySegment[]): ElevateFn {
  return (s, lateral) => terrainElevation(s, lateral) * (1 - cityBlend(city, s));
}

export interface RoadHandle {
  group: THREE.Group;
  dispose(): void;
}

/**
 * A vertical strip following the track - used for the guardrail. Unlike
 * `ribbonGeometry`, its two edges differ in height rather than lateral offset.
 */
export function railGeometry(
  track: Track,
  lateral: number,
  yBottom: number,
  yTop: number,
  step = track.step,
): THREE.BufferGeometry {
  const rows = Math.ceil(track.length / step) + 1;
  const positions = new Float32Array(rows * 2 * 3);
  const uvs = new Float32Array(rows * 2 * 2);
  const indices: number[] = [];
  const p = { x: 0, y: 0, z: 0, heading: 0, curvature: 0 };

  for (let r = 0; r < rows; r++) {
    const s = Math.min(track.length, r * step);
    track.toWorld(s, lateral, p);
    for (let c = 0; c < 2; c++) {
      const i = (r * 2 + c) * 3;
      positions[i] = p.x;
      positions[i + 1] = p.y + (c === 0 ? yBottom : yTop);
      positions[i + 2] = p.z;
      const j = (r * 2 + c) * 2;
      uvs[j] = c;
      uvs[j + 1] = s / 4; // one texture tile every 4 m of rail
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    const a = r * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export function buildRoad(
  track: Track,
  _preset: SkyPreset,
  textures: GroundTextures,
  city: readonly CitySegment[] = [],
): RoadHandle {
  const elevate = makeTerrainElevation(city);
  const group = new THREE.Group();
  group.name = 'road';
  const disposables: { dispose(): void }[] = [];

  const half = track.halfWidth;
  const shoulderEdge = half + track.shoulder;

  // --- asphalt ---------------------------------------------------------
  const roadMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.02 });
  applyPbr(roadMat, textures.asphalt, { normalScale: 0.7, roughness: 0.95 });
  const roadGeo = ribbonGeometry(track, [{ lateral: -half, u: 0 }, { lateral: half, u: 1 }], half * 2);
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.receiveShadow = true;
  road.name = 'asphalt';
  group.add(road);
  disposables.push(roadGeo, roadMat);

  // --- lane markings ------------------------------------------------------
  // Their own ribbon just above the asphalt: the paint stays sharp while the
  // road texture below tiles at its own real-world scale.
  const markTex = makeMarkingsTexture({ halfWidth: half });
  const markMat = new THREE.MeshBasicMaterial({
    map: markTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const markGeo = ribbonGeometry(
    track,
    [{ lateral: -half, u: 0 }, { lateral: half, u: 1 }],
    half * 2,
    () => 0.015,
  );
  const markings = new THREE.Mesh(markGeo, markMat);
  markings.renderOrder = 1;
  markings.name = 'markings';
  group.add(markings);
  disposables.push(markGeo, markMat, markTex);

  // --- gravel shoulders -------------------------------------------------
  const dirtMat = new THREE.MeshStandardMaterial({ roughness: 1 });
  applyPbr(dirtMat, textures.gravel, { normalScale: 1.2, roughness: 1 });
  for (const sign of [-1, 1]) {
    const inner = sign * (half - 0.05);
    const outer = sign * (shoulderEdge + 0.6);
    const bands: Band[] = sign < 0
      ? [{ lateral: outer, u: 0 }, { lateral: inner, u: 1 }]
      : [{ lateral: inner, u: 0 }, { lateral: outer, u: 1 }];
    const geo = ribbonGeometry(track, bands, 8);
    const mesh = new THREE.Mesh(geo, dirtMat);
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(geo);
  }
  disposables.push(dirtMat);

  // --- guardrails ----------------------------------------------------------
  // Placed exactly on the out-of-bounds line, so what you see is what you hit.
  const railTex = makeGuardrailTexture();
  const railMat = new THREE.MeshStandardMaterial({
    map: railTex,
    roughness: 0.42,
    metalness: 0.75,
    side: THREE.DoubleSide,
  });
  for (const sign of [-1, 1]) {
    const geo = railGeometry(track, sign * shoulderEdge, 0.42, 0.95);
    const rail = new THREE.Mesh(geo, railMat);
    rail.castShadow = true;
    rail.receiveShadow = true;
    rail.name = `guardrail-${sign > 0 ? 'right' : 'left'}`;
    group.add(rail);
    disposables.push(geo);
  }
  disposables.push(railMat, railTex);

  // --- terrain ------------------------------------------------------------
  const grassMat = new THREE.MeshStandardMaterial({ roughness: 1 });
  applyPbr(grassMat, textures.grass, { normalScale: 0.9, roughness: 1 });
  const far = 260;
  for (const sign of [-1, 1]) {
    // Extra bands near the road keep the hills from looking like folded paper.
    const laterals = [shoulderEdge + 0.4, 18, 26, 36, 50, 70, 100, 145, 200, far].map((v) => v * sign);
    const bands: Band[] = laterals.map((lateral) => ({ lateral, u: Math.abs(lateral) / 40 }));
    if (sign < 0) bands.reverse();
    const geo = ribbonGeometry(track, bands, 40, elevate);
    const mesh = new THREE.Mesh(geo, grassMat);
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(geo);
  }
  disposables.push(grassMat);

  return {
    group,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/** Checkered band painted across the road. */
function checkerStrip(track: Track, s: number, length = 3, squaresAcross = 14): THREE.Mesh {
  const tex = makeCheckerTexture({ squares: 2 });
  // One texture tile is a 2x2 check, so half as many tiles as squares wanted.
  const rows = Math.max(1, Math.round((length / (track.halfWidth * 2)) * squaresAcross));
  tex.repeat.set(squaresAcross / 2, rows / 2);
  const geo = ribbonGeometry(
    track,
    [{ lateral: -track.halfWidth, u: 0 }, { lateral: track.halfWidth, u: 1 }],
    length,
    (_s, _lateral) => 0.012, // float just above the asphalt to beat z-fighting
    length / 2,
    s,
    s + length,
  );
  // Unlit: painted checks should read as black and white, not wash out under
  // a midday sun.
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `checker-${s}`;
  return mesh;
}

/**
 * Start line: a wide checkered band right across the road, flanked by
 * checkered markers on both kerbs and the centre line.
 */
export function buildStartLine(track: Track): THREE.Group {
  const group = new THREE.Group();
  group.name = 'startline';
  group.add(checkerStrip(track, 0, 8));

  const coneTex = makeCheckerTexture({ squares: 4 });
  const coneMat = new THREE.MeshStandardMaterial({ map: coneTex, roughness: 0.7 });
  const coneGeo = new THREE.CylinderGeometry(0.16, 0.38, 1.25, 10);
  const baseGeo = new THREE.CylinderGeometry(0.46, 0.5, 0.14, 12);
  const baseMat = new THREE.MeshStandardMaterial({ color: 0xe6e6e6, roughness: 0.8 });

  for (const lateral of [-track.halfWidth + 0.9, -0.2, track.halfWidth - 0.9]) {
    const at = track.toWorld(0, lateral);
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(at.x, at.y + 0.7, at.z);
    cone.castShadow = true;
    group.add(cone);

    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.set(at.x, at.y + 0.07, at.z);
    group.add(base);
  }
  return group;
}

/** Finish gantry: two towers and a banner across the road. */
export function buildFinishLine(track: Track, s: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'finish';
  group.add(checkerStrip(track, s, 4));

  const p = track.toWorld(s, 0);
  const heading = p.heading;
  const postMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.6, metalness: 0.4 });
  const postGeo = new THREE.BoxGeometry(0.7, 9, 0.7);

  for (const sign of [-1, 1]) {
    const at = track.toWorld(s, sign * (track.halfWidth + 1.4));
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(at.x, at.y + 4.5, at.z);
    post.rotation.y = heading;
    post.castShadow = true;
    group.add(post);
  }

  // Banner across the top.
  const bannerW = (track.halfWidth + 1.4) * 2;
  const bannerGeo = new THREE.BoxGeometry(bannerW, 2.4, 0.35);
  const bannerMat = new THREE.MeshStandardMaterial({
    color: 0xff4d1c,
    emissive: 0xff2a00,
    emissiveIntensity: 0.45,
    roughness: 0.5,
  });
  const banner = new THREE.Mesh(bannerGeo, bannerMat);
  banner.position.set(p.x, p.y + 8.2, p.z);
  banner.rotation.y = heading;
  banner.castShadow = true;
  group.add(banner);

  return group;
}

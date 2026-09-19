// Track geometry: asphalt, gravel shoulders and rolling terrain, all generated
// as ribbons that follow the centreline so they hug every crest and corner.

import * as THREE from 'three';
import { TRACK } from '../sim/config';
import type { Track } from '../sim/track';
import type { SkyPreset } from './palette';
import {
  makeMarkingsTexture, makeCheckerTexture, makeGuardrailTexture, makePavementTexture,
} from './textures';
import { applyPbr, type GroundTextures } from './assets';
import { blendAt, coastAt, type BiomeSegment } from '../sim/biomes';

/**
 * How far the ground is built behind the start line. The grid sits at s=0 and
 * the chase camera a few metres behind that, so without a run-up the bottom of
 * the screen during the countdown is just open sky.
 */
export const START_RUNUP = 120;

export interface Band {
  /** Constant offset, or one that varies along the track (the median does). */
  lateral: number | ((s: number) => number);
  u: number;
  /**
   * Height for this band alone, added on top of the ribbon's `elevate`. Lets a
   * strip carry its own kerb: two bands at the same lateral, different heights.
   */
  lift?: number | ((s: number) => number);
}

const bandAt = (band: Band, s: number): number =>
  typeof band.lateral === 'function' ? band.lateral(s) : band.lateral;

const liftAt = (band: Band, s: number): number =>
  band.lift === undefined ? 0 : typeof band.lift === 'function' ? band.lift(s) : band.lift;

/**
 * Close the open edge of a raised ribbon with a kerb face: a copy of the
 * outermost band dropped below the surface it sits on.
 *
 * A raised slab with no riser is a slab floating in mid-air. At the grazing
 * angles you ride at, a view ray crossing the edge just below the top slips
 * underneath it, misses every surface in the scene and renders the sky dome -
 * so the kerb reads as a bright hairline of sky running its whole length.
 *
 * The full-height duplicate beside each face is what keeps the top flat: the
 * zero-area quad between the twins contributes nothing to `computeVertexNormals`,
 * so the riser stays vertical instead of averaging into the surface.
 */
export function withKerbFaces(bands: Band[], drop: number | ((s: number) => number)): Band[] {
  const first = bands[0];
  const last = bands[bands.length - 1];
  return [
    { ...first, lift: drop },
    { ...first },
    ...bands.slice(1, -1),
    { ...last },
    { ...last, lift: drop },
  ];
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
  fromS = -START_RUNUP,
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
      const lateral = bandAt(band, s);
      track.toWorld(s, lateral, p);
      const i = (r * cols + c) * 3;
      positions[i] = p.x;
      positions[i + 1] = p.y + (elevate ? elevate(s, lateral) : 0) + liftAt(band, s);
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

/** Stepped paddy terraces: flat platforms falling away from the road. */
function paddyProfile(_s: number, lateral: number): number {
  const d = Math.max(0, Math.abs(lateral) - 16);
  // Each terrace is 26 m wide and drops 0.7 m from the one before it.
  return -Math.floor(d / 26) * 0.7 - 0.25;
}

/** Ground falling away into the sea on one side of the road. */
function coastProfile(lateral: number, side: number, drop: number): number {
  const out = lateral * side; // positive on the seaward side
  if (out <= 0) {
    // Inland: a low bank rising away from the road.
    return Math.min(4, Math.max(0, -out - 18) * 0.12);
  }
  // Beach, then seabed.
  const beach = Math.max(0, out - 16);
  return -Math.min(drop + 3, beach * 0.22);
}

/**
 * Terrain height for the whole track, blended between biomes. Returns an
 * offset from the road surface, so 0 is level with the tarmac.
 */
export function makeTerrainElevation(biomes: readonly BiomeSegment[]): ElevateFn {
  return (s, lateral) => {
    const rolling = terrainElevation(s, lateral);

    const city = blendAt(biomes, s, 'city');
    const hills = blendAt(biomes, s, 'hills');
    const paddy = blendAt(biomes, s, 'paddy');
    const jungle = blendAt(biomes, s, 'jungle');
    const mountain = blendAt(biomes, s, 'mountain');
    const village = blendAt(biomes, s, 'village');
    const { side, blend: coast } = coastAt(biomes, s);

    // Country rolling, flattened through town, the paddies and the village.
    let h = rolling * (1 - city) * (1 - paddy * 0.9) * (1 - village * 0.55);

    // Hills: the same profile, considerably louder, plus a second ridge.
    if (hills > 0) {
      const ridge =
        Math.sin(s * 0.0062 + 1.7) * 16 + Math.sin(lateral * 0.011 + s * 0.002) * 9;
      const d = Math.max(0, Math.abs(lateral) - 18);
      const falloff = Math.min(1, d / 40);
      h += (rolling * 1.6 + ridge * falloff * falloff) * hills;
    }

    // Jungle sits in a shallow valley, which closes the sightlines in.
    if (jungle > 0) {
      const d = Math.max(0, Math.abs(lateral) - 15);
      h += Math.min(1, d / 30) * 6 * jungle;
    }

    // Mountains: steep walls rising close to the road, so it reads as a pass
    // cut through rather than open hills.
    if (mountain > 0) {
      const d = Math.max(0, Math.abs(lateral) - 20);
      const climb = Math.min(1, d / 55);
      const wall = climb * climb * (46 + Math.sin(s * 0.0035 + 0.7) * 26);
      const ridge = Math.sin(s * 0.0021 + 2.4) * 22 + Math.sin(lateral * 0.006) * 14;
      h += (wall + ridge * climb) * mountain;
    }

    if (paddy > 0) h += (paddyProfile(s, lateral) - h) * paddy;
    if (coast > 0 && side !== 0) {
      h += (coastProfile(lateral, side, TRACK.coastDrop) - h) * coast;
    }
    return h;
  };
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
  lateral: number | ((s: number) => number),
  yBottom: number,
  yTop: number,
  step = track.step,
): THREE.BufferGeometry {
  const at = (s: number) => (typeof lateral === 'function' ? lateral(s) : lateral);
  const rows = Math.ceil((track.length + START_RUNUP) / step) + 1;
  const positions = new Float32Array(rows * 2 * 3);
  const uvs = new Float32Array(rows * 2 * 2);
  const indices: number[] = [];
  const p = { x: 0, y: 0, z: 0, heading: 0, curvature: 0 };

  for (let r = 0; r < rows; r++) {
    const s = Math.min(track.length, -START_RUNUP + r * step);
    track.toWorld(s, at(s), p);
    for (let c = 0; c < 2; c++) {
      const i = (r * 2 + c) * 3;
      positions[i] = p.x;
      positions[i + 1] = p.y + (c === 0 ? yBottom : yTop);
      positions[i + 2] = p.z;
      const j = (r * 2 + c) * 2;
      uvs[j] = c;
      uvs[j + 1] = (s + START_RUNUP) / 4; // one texture tile every 4 m of rail
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
  biomes: readonly BiomeSegment[] = [],
): RoadHandle {
  const elevate = makeTerrainElevation(biomes);
  const group = new THREE.Group();
  group.name = 'road';
  const disposables: { dispose(): void }[] = [];

  const half = track.halfWidth;
  const shoulderEdge = half + track.shoulder;
  // Anything whose width changes along the road - the carriageways, the
  // median, the shoulders, the rails - needs finer sampling than the 4 m
  // centreline spacing, or the ramp into a split shows up as a jagged wedge.
  const SPLIT_STEP = 1.5;

  // --- asphalt ---------------------------------------------------------
  const roadMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.02 });
  applyPbr(roadMat, textures.asphalt, { normalScale: 0.7, roughness: 0.95 });
  // Two carriageways with the median between them. Where the road is
  // undivided the median has zero width, so the two ribbons meet in the
  // middle and it reads as one surface.
  // Each carriageway takes HALF the marking texture, not all of it. Giving
  // both halves u 0..1 puts the double-yellow (at u=0.5) down the middle of
  // each carriageway instead of down the middle of the road.
  const innerEdge = (sign: number) => (s: number) => sign * track.medianAt(s);
  const outerEdge = (sign: number) => (s: number) => sign * track.edgeAt(s);
  const carriageway = (sign: number): Band[] =>
    sign < 0
      ? [{ lateral: outerEdge(-1), u: 0 }, { lateral: innerEdge(-1), u: 0.5 }]
      : [{ lateral: innerEdge(1), u: 0.5 }, { lateral: outerEdge(1), u: 1 }];

  for (const sign of [-1, 1]) {
    const geo = ribbonGeometry(track, carriageway(sign), half * 2, undefined, SPLIT_STEP);
    const mesh = new THREE.Mesh(geo, roadMat);
    mesh.receiveShadow = true;
    mesh.name = 'asphalt';
    group.add(mesh);
    disposables.push(geo);
  }
  disposables.push(roadMat);

  // --- lane markings ------------------------------------------------------
  // Their own ribbon just above the asphalt: the paint stays sharp while the
  // road texture below tiles at its own real-world scale.
  const markTex = makeMarkingsTexture({ halfWidth: half });
  // Lit, not unlit: road paint is still paint at night. Unlit white lines
  // stay at full brightness after dark and bloom into glowing strips.
  const markMat = new THREE.MeshStandardMaterial({
    map: markTex,
    roughness: 0.75,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  for (const sign of [-1, 1]) {
    const geo = ribbonGeometry(track, carriageway(sign), half * 2, () => 0.015, SPLIT_STEP);
    const markings = new THREE.Mesh(geo, markMat);
    markings.renderOrder = 1;
    markings.name = 'markings';
    group.add(markings);
    disposables.push(geo);
  }
  disposables.push(markMat, markTex);

  // --- gravel shoulders -------------------------------------------------
  const dirtMat = new THREE.MeshStandardMaterial({ roughness: 1 });
  applyPbr(dirtMat, textures.gravel, { normalScale: 1.2, roughness: 1 });
  for (const sign of [-1, 1]) {
    const inner = (s: number) => sign * (track.edgeAt(s) - 0.05);
    const outer = (s: number) => sign * (track.edgeAt(s) + track.shoulder + 0.6);
    const bands: Band[] = sign < 0
      ? [{ lateral: outer, u: 0 }, { lateral: inner, u: 1 }]
      : [{ lateral: inner, u: 0 }, { lateral: outer, u: 1 }];
    const geo = ribbonGeometry(track, bands, 8, undefined, SPLIT_STEP);
    const mesh = new THREE.Mesh(geo, dirtMat);
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(geo);
  }
  disposables.push(dirtMat);

  // --- median ---------------------------------------------------------------
  // Grass between the carriageways. It collapses to nothing where the road is
  // undivided, so it costs one ribbon for the whole track either way.
  if (track.divided.length) {
    const medianMat = new THREE.MeshStandardMaterial({ roughness: 1 });
    applyPbr(medianMat, textures.grass, { normalScale: 0.9, roughness: 1 });
    // Several columns across, so a wide island is not two long thin triangles.
    const columns = 6;
    const top: Band[] = Array.from({ length: columns + 1 }, (_, i) => {
      const f = (i / columns) * 2 - 1; // -1 .. 1
      return {
        lateral: (s: number) => f * track.medianAt(s),
        u: (f + 1) / 2,
      };
    });
    // Slightly proud of the tarmac, like a raised grass median.
    const raised = (s: number) => track.medianAt(s) > 0.05;
    const MEDIAN_KERB = 0.06;
    const geo = ribbonGeometry(
      track,
      // Drop the kerb faces below the tarmac so their bottom edge is buried
      // rather than z-fighting the asphalt they meet.
      withKerbFaces(top, (s) => (raised(s) ? -(MEDIAN_KERB + 0.02) : 0)),
      6,
      (s) => (raised(s) ? MEDIAN_KERB : -0.02),
      SPLIT_STEP,
    );
    const median = new THREE.Mesh(geo, medianMat);
    median.receiveShadow = true;
    median.name = 'median';
    group.add(median);
    disposables.push(geo, medianMat);
  }

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
    const geo = railGeometry(track, (s) => sign * (track.edgeAt(s) + track.shoulder), 0.42, 0.95, SPLIT_STEP);
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
    const bands: Band[] = [
      // Inner edge tracks the road, so it stays put against the shoulder
      // however far a fork pushes the carriageways apart.
      { lateral: (s: number) => sign * (track.edgeAt(s) + track.shoulder + 0.4), u: (shoulderEdge + 0.4) / 40 },
      ...[26, 36, 50, 70, 100, 145, 200, far].map((v) => ({
        lateral: (s: number) => sign * Math.max(v, track.edgeAt(s) + track.shoulder + 2),
        u: v / 40,
      })),
    ];
    if (sign < 0) bands.reverse();
    const geo = ribbonGeometry(track, bands, 40, elevate, SPLIT_STEP * 2);
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

/**
 * Raised concrete pavement through the city sections, with a kerb along the
 * road edge. Grass verges beside city blocks look like a park; pavement is
 * what makes a street read as a street.
 */
export function buildPavements(
  track: Track,
  biomes: readonly BiomeSegment[],
): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group();
  group.name = 'pavements';
  const cities = biomes.filter((b) => b.kind === 'city');
  if (!cities.length) return { group, dispose() {} };

  const tex = makePavementTexture();
  tex.repeat.set(1, 1);
  const material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0.02 });
  const geos: THREE.BufferGeometry[] = [];
  const WIDTH = 5.5;
  const KERB = 0.16;

  for (const seg of cities) {
    const from = Math.max(0, seg.from - 20);
    const to = Math.min(track.length, seg.to + 20);
    for (const sign of [-1, 1]) {
      // Starts at the kerb, where the gravel shoulder would otherwise be.
      const inner = (s: number) => sign * (track.edgeAt(s) + 0.05);
      const outer = (s: number) => sign * (track.edgeAt(s) + 0.05 + WIDTH);
      const bands: Band[] = sign < 0
        ? [{ lateral: outer, u: 1 }, { lateral: inner, u: 0 }]
        : [{ lateral: inner, u: 0 }, { lateral: outer, u: 1 }];
      const geo = ribbonGeometry(
        track, withKerbFaces(bands, -(KERB + 0.03)), WIDTH, () => KERB, 2, from, to,
      );
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      mesh.name = 'pavement';
      group.add(mesh);
      geos.push(geo);
    }
  }

  return {
    group,
    dispose() {
      for (const g of geos) g.dispose();
      material.dispose();
      tex.dispose();
    },
  };
}

/**
 * Sea along the coast sections. Each one is a flat ribbon at the height the
 * track recorded for it, running from the shore out past the draw distance.
 */
export function buildWater(
  track: Track,
  biomes: readonly BiomeSegment[],
  preset: SkyPreset,
): { group: THREE.Group; material: THREE.MeshStandardMaterial | null; dispose(): void } {
  const group = new THREE.Group();
  group.name = 'water';
  const coasts = biomes.filter((b) => b.kind === 'coast');
  if (!coasts.length) return { group, material: null, dispose() {} };

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(preset.horizon).lerp(new THREE.Color(0x0d3b5c), 0.72),
    roughness: 0.12,
    metalness: 0.35,
    envMapIntensity: 1.5,
    transparent: true,
    opacity: 0.94,
  });

  const geos: THREE.BufferGeometry[] = [];
  for (const seg of coasts) {
    const level = track.seaLevels.get(seg.from);
    if (level == null) continue;
    const side = seg.side;
    if (side === 0) continue;

    // Run a little past the section so the shoreline does not end abruptly.
    const from = Math.max(0, seg.from - 140);
    const to = Math.min(track.length, seg.to + 140);
    const near = side * 14;
    const far = side * 420;
    const geo = ribbonGeometry(
      track,
      side < 0
        ? [{ lateral: far, u: 0 }, { lateral: near, u: 1 }]
        : [{ lateral: near, u: 0 }, { lateral: far, u: 1 }],
      40,
      // A flat sea: cancel out the road's own elevation.
      (s) => level - track.sampleAt(s).y,
      8,
      from,
      to,
    );
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `sea-${Math.round(seg.from)}`;
    group.add(mesh);
    geos.push(geo);
  }

  return {
    group,
    material,
    dispose() {
      for (const g of geos) g.dispose();
      material.dispose();
    },
  };
}

/**
 * Flooded rice terraces. The terrain already steps down away from the road in
 * paddy sections; this lays a sheet of water on each step and a raised bund
 * between them, which is what makes them read as paddies rather than fields.
 */
export function buildPaddies(
  track: Track,
  biomes: readonly BiomeSegment[],
): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group();
  group.name = 'paddies';
  const fields = biomes.filter((b) => b.kind === 'paddy');
  if (!fields.length) return { group, dispose() {} };

  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x6d7f52,
    roughness: 0.18,
    metalness: 0.2,
    envMapIntensity: 1.3,
  });
  const bundMat = new THREE.MeshStandardMaterial({ color: 0x6a5a42, roughness: 1 });
  const disposables: { dispose(): void }[] = [waterMat, bundMat];

  const TERRACE = 26;
  const STEP = 0.7;
  const inner = 16;

  for (const seg of fields) {
    const from = Math.max(0, seg.from - 40);
    const to = Math.min(track.length, seg.to + 40);

    for (const sign of [-1, 1]) {
      // Four terraces stepping away from the road on each side.
      for (let tier = 0; tier < 4; tier++) {
        const near = inner + tier * TERRACE;
        const far = near + TERRACE;
        const height = -tier * STEP - 0.25;

        // Water sheet, a few centimetres below the bund tops.
        const waterGeo = ribbonGeometry(
          track,
          sign < 0
            ? [{ lateral: -far + 1.2, u: 0 }, { lateral: -near - 1.2, u: 1 }]
            : [{ lateral: near + 1.2, u: 0 }, { lateral: far - 1.2, u: 1 }],
          30,
          () => height + 0.08,
          8,
          from,
          to,
        );
        const water = new THREE.Mesh(waterGeo, waterMat);
        group.add(water);
        disposables.push(waterGeo);

        // Raised earth bund along the outer edge of the terrace.
        const bundGeo = ribbonGeometry(
          track,
          sign < 0
            ? [{ lateral: -far - 0.9, u: 0 }, { lateral: -far + 0.9, u: 1 }]
            : [{ lateral: far - 0.9, u: 0 }, { lateral: far + 0.9, u: 1 }],
          10,
          () => height + 0.3,
          8,
          from,
          to,
        );
        const bund = new THREE.Mesh(bundGeo, bundMat);
        bund.receiveShadow = true;
        group.add(bund);
        disposables.push(bundGeo);
      }
    }
  }

  return {
    group,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/**
 * Checkered band painted across the road. Split around the median, so on a
 * divided stretch it paints both carriageways and not the island between them.
 */
function checkerStrips(track: Track, s: number, length = 3, squaresAcross = 14): THREE.Mesh[] {
  const tex = makeCheckerTexture({ squares: 2 });
  const rows = Math.max(1, Math.round((length / (track.halfWidth * 2)) * squaresAcross));
  tex.repeat.set(squaresAcross / 2, rows / 2);
  // Lit like the tarmac it is painted on. Unlit renders the white squares at
  // full brightness whatever the time of day, which at dusk is far brighter
  // than anything around it and trips the bloom pass into a glowing slab.
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 });

  const meshes: THREE.Mesh[] = [];
  for (const sign of [-1, 1]) {
    const inner: Band = { lateral: (x: number) => sign * track.medianAt(x), u: sign < 0 ? 1 : 0 };
    const outer: Band = { lateral: (x: number) => sign * track.edgeAt(x), u: sign < 0 ? 0 : 1 };
    const geo = ribbonGeometry(
      track,
      sign < 0 ? [outer, inner] : [inner, outer],
      length / 2,
      // Float just above the asphalt to beat z-fighting.
      () => 0.012,
      Math.min(1, length / 4),
      s,
      s + length,
    );
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `checker-${s}`;
    mesh.renderOrder = 2;
    meshes.push(mesh);
  }
  return meshes;
}

/**
 * Start line: a wide checkered band right across the road, flanked by
 * checkered markers on both kerbs and the centre line.
 */
export function buildStartLine(track: Track): THREE.Group {
  const group = new THREE.Group();
  group.name = 'startline';
  group.add(...checkerStrips(track, 0, 8));

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
  group.add(...checkerStrips(track, s, 4));

  const p = track.toWorld(s, 0);
  const heading = p.heading;
  const postMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.6, metalness: 0.4 });
  const postGeo = new THREE.BoxGeometry(0.7, 9, 0.7);

  // Posts stand outside the tarmac at THIS point, which on a divided stretch
  // is a good deal wider than the nominal half width.
  const span = track.edgeAt(s) + 1.4;
  for (const sign of [-1, 1]) {
    const at = track.toWorld(s, sign * span);
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(at.x, at.y + 4.5, at.z);
    post.rotation.y = heading;
    post.castShadow = true;
    group.add(post);
  }

  // Banner across the top, spanning both carriageways.
  const bannerW = span * 2;
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

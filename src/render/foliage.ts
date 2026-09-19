// Photographic trees.
//
// Whole-tree cut-outs are not something the CC0 libraries carry, but branch
// atlases are. So: load a photographed conifer spray (and a broadleaf sprig),
// then composite them tier by tier into a tree-shaped billboard at runtime.
// The result is real needles and real leaves rather than drawn ones, on two
// crossed planes per tree.
//
// Source: ambientCG LeafSet019 / LeafSet005, CC0.

import * as THREE from 'three';
import type { Rng } from '../sim/types';

export interface FoliageAtlas {
  conifer: HTMLCanvasElement | null;
  broadleaf: HTMLCanvasElement | null;
  oak: HTMLCanvasElement | null;
  maple: HTMLCanvasElement | null;
  blade: HTMLCanvasElement | null;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

/**
 * Combine a colour map and a separate greyscale opacity map into one RGBA
 * canvas. The opacity file is opaque greyscale, so its red channel has to be
 * copied into the colour image's alpha channel by hand.
 */
async function loadCutout(colorUrl: string, alphaUrl: string): Promise<HTMLCanvasElement> {
  const [colour, alpha] = await Promise.all([loadImage(colorUrl), loadImage(alphaUrl)]);
  const w = colour.width;
  const h = colour.height;

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.drawImage(colour, 0, 0);
  const colourData = ctx.getImageData(0, 0, w, h);

  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d');
  if (!tctx) throw new Error('2D context unavailable');
  tctx.drawImage(alpha, 0, 0, w, h);
  const alphaData = tctx.getImageData(0, 0, w, h);

  for (let i = 0; i < colourData.data.length; i += 4) {
    colourData.data[i + 3] = alphaData.data[i];
  }
  ctx.putImageData(colourData, 0, 0);
  return out;
}

export async function loadFoliageAtlas(): Promise<FoliageAtlas> {
  const grab = async (a: string, b: string) => {
    try {
      return await loadCutout(a, b);
    } catch (err) {
      console.warn('[motorush] foliage atlas unavailable', err);
      return null;
    }
  };
  const [conifer, broadleaf, oak, maple, blade] = await Promise.all([
    grab('/textures/conifer_color.png', '/textures/conifer_alpha.png'),
    grab('/textures/broadleaf_color.png', '/textures/broadleaf_alpha.png'),
    grab('/textures/oakleaf_color.png', '/textures/oakleaf_alpha.png'),
    grab('/textures/maple_color.png', '/textures/maple_alpha.png'),
    grab('/textures/grassblade_color.png', '/textures/grassblade_alpha.png'),
  ]);
  return { conifer, broadleaf, oak, maple, blade };
}

/** Where each usable sprig sits in its atlas, in 0..1 coordinates. */
const CONIFER_SPRAYS = [
  { x: 0.23, y: 0.03, w: 0.73, h: 0.24 },
  { x: 0.01, y: 0.26, w: 0.98, h: 0.35 },
  { x: 0.0, y: 0.62, w: 0.99, h: 0.35 },
];

// Weighted toward the multi-leaf sprig: a card carrying one enormous single
// leaf reads as a leaf, not as foliage.
/** Leaf sets are laid out as a row of specimens; sample a few of each. */
const ROW_CROPS = (count: number, top = 0.04, height = 0.9): Crop[] =>
  Array.from({ length: count }, (_, i) => ({
    x: i / count + 0.01,
    y: top,
    w: 1 / count - 0.02,
    h: height,
  }));

const OAK_LEAVES = ROW_CROPS(4);
const MAPLE_LEAVES = ROW_CROPS(4);
/** Grass blades: tall, narrow, and used for turf, reeds and palm fronds. */
const BLADES = ROW_CROPS(8, 0.02, 0.96);

const BROADLEAF_SPRIGS = [
  { x: 0.0, y: 0.05, w: 0.34, h: 0.9 },
  { x: 0.0, y: 0.05, w: 0.34, h: 0.9 },
  { x: 0.0, y: 0.05, w: 0.34, h: 0.9 },
  { x: 0.33, y: 0.05, w: 0.22, h: 0.75 },
  { x: 0.55, y: 0.03, w: 0.22, h: 0.82 },
  { x: 0.76, y: 0.05, w: 0.23, h: 0.78 },
];

export type TreeSpecies = 'conifer' | 'broadleaf' | 'oak' | 'maple' | 'palm' | 'bush' | 'jungle';

export interface TreeVariant {
  species: TreeSpecies;
  /** Canopy radius as a fraction of the tree's height. */
  radius: number;
  /** The atlas this canopy samples from. */
  texture: THREE.CanvasTexture;
  /** Canopy geometry for a unit-height tree, base at y=0. */
  geometry: THREE.BufferGeometry;
  conifer: boolean;
}

interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Build a canopy out of many small foliage cards scattered through a 3D
 * volume, rather than a few large crossed planes.
 *
 * Crossed planes always betray themselves: from an oblique angle you catch
 * them near edge-on and the tree flattens into a card. Sixty-odd small quads
 * distributed through a cone (or an ellipsoid) have real depth from every
 * direction, cost about 120 triangles, and sample the photographic atlas
 * directly so the needles stay sharp instead of being resampled into a
 * tree-sized canvas.
 */
export interface CanopyOptions {
  cards?: number;
  conifer?: boolean;
  radius?: number;
  taper?: number;
  cardSize?: number;
  baseY?: number;
  shape?: 'default' | 'palm' | 'bush';
  /** Extra tilt on palm fronds; negative lifts them, positive droops them. */
  droop?: number;
}

function buildCanopy(
  crops: Crop[],
  rng: Rng,
  {
    cards = 64,
    conifer = true,
    radius = 0.34,
    taper = 1.0,
    cardSize = 0.34,
    baseY = 0.07,
    shape = 'default',
    droop = 0,
  }: CanopyOptions = {},
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const outward = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const corner = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);

  const pushCard = (
    cx: number, cy: number, cz: number,
    nx: number, nz: number,
    w: number, h: number,
    crop: Crop,
    tilt: number,
  ) => {
    outward.set(nx, 0, nz).normalize();
    // Card plane: `right` across the face, `up` roughly vertical but tilted.
    right.crossVectors(WORLD_UP, outward).normalize();
    up.copy(WORLD_UP).addScaledVector(outward, tilt).normalize();
    centre.set(cx, cy, cz);

    const base = positions.length / 3;
    // Foliage shades better with a normal biased upward - straight outward
    // makes the underside of the canopy read as unlit.
    const nlen = Math.hypot(outward.x, 0.9, outward.z);
    for (const [sx, sy, u, v] of [
      [-0.5, -0.5, 0, 0],
      [0.5, -0.5, 1, 0],
      [0.5, 0.5, 1, 1],
      [-0.5, 0.5, 0, 1],
    ] as const) {
      corner.copy(centre)
        .addScaledVector(right, sx * w)
        .addScaledVector(up, sy * h);
      positions.push(corner.x, corner.y, corner.z);
      normals.push(outward.x / nlen, 0.9 / nlen, outward.z / nlen);
      uvs.push(crop.x + u * crop.w, 1 - (crop.y + (1 - v) * crop.h));
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    // Mirrored copy so the card is visible from behind without a DoubleSide
    // material, which would negate the normal and black out half the canopy.
    const b2 = positions.length / 3;
    for (const [sx, sy, u, v] of [
      [0.5, -0.5, 1, 0],
      [-0.5, -0.5, 0, 0],
      [-0.5, 0.5, 0, 1],
      [0.5, 0.5, 1, 1],
    ] as const) {
      corner.copy(centre)
        .addScaledVector(right, sx * w)
        .addScaledVector(up, sy * h);
      positions.push(corner.x, corner.y, corner.z);
      normals.push(-outward.x / nlen, 0.9 / nlen, -outward.z / nlen);
      uvs.push(crop.x + u * crop.w, 1 - (crop.y + (1 - v) * crop.h));
    }
    indices.push(b2, b2 + 1, b2 + 2, b2, b2 + 2, b2 + 3);
  };

  for (let i = 0; i < cards; i++) {
    const crop = crops[Math.floor(rng() * crops.length)];
    const aspect = crop.h / crop.w;

    let y: number;
    let ringR: number;
    if (shape === 'palm') {
      // A crown of fronds bursting from the top of a bare trunk.
      y = 0.84 + rng() * 0.12;
      ringR = radius * (0.5 + rng() * 0.6);
    } else if (shape === 'bush') {
      const rel = (rng() - 0.5) * 2;
      y = 0.45 + rel * 0.4;
      ringR = radius * Math.sqrt(Math.max(0.05, 1 - rel * rel));
    } else if (conifer) {
      // Bias cards toward the base so the cone fills out properly.
      const t = Math.pow(rng(), 0.72);
      y = baseY + t * (1 - baseY);
      ringR = radius * Math.pow(1 - t, taper) + 0.03;
    } else {
      // Ellipsoid crown, centred on the same height the radius falls off
      // around - distributing about one centre and measuring from another
      // gives a lopsided cylinder rather than a crown.
      const CROWN_Y = 0.62;
      const CROWN_H = 0.34;
      const rel = (rng() - 0.5) * 2; // -1 .. 1
      y = CROWN_Y + rel * CROWN_H;
      ringR = radius * Math.sqrt(Math.max(0.05, 1 - rel * rel));
    }

    const angle = rng() * Math.PI * 2;
    // Fill from near the trunk outward. Starting the cards well off-axis
    // leaves a gap between canopy and trunk, and the outermost ones then read
    // as clumps floating in mid-air.
    const r = ringR * (0.12 + Math.sqrt(rng()) * 0.9);
    const px = Math.cos(angle) * r;
    const pz = Math.sin(angle) * r;

    const w = cardSize * (0.7 + rng() * 0.6) * (conifer ? 0.6 + ringR * 1.6 : 1);
    // Palm fronds hang outward and down; everything else just tilts a little.
    const tilt = shape === 'palm' ? -0.8 - rng() * 0.7 + droop : (rng() - 0.5) * 0.7;
    pushCard(px, y, pz, Math.cos(angle), Math.sin(angle), w, w * aspect, crop, tilt);
  }

  // Trunk: a couple of crossed quads in bark brown, using a clean corner of
  // the atlas would tint it green, so it is drawn as untextured dark geometry
  // via a very small UV patch at the darkest part of a crop.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/** Build the full roster of canopies from the atlases. */
export function buildTreeVariants(atlas: FoliageAtlas, rng: Rng): TreeVariant[] {
  const variants: TreeVariant[] = [];

  const asTexture = (canvas: HTMLCanvasElement) => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  };

  const add = (
    species: TreeSpecies,
    canvas: HTMLCanvasElement | null,
    crops: Crop[],
    texture: THREE.CanvasTexture | null,
    shapes: CanopyOptions[],
  ) => {
    if (!canvas || !texture) return;
    for (const shape of shapes) {
      variants.push({
        species,
        radius: shape.radius ?? 0.34,
        texture,
        geometry: buildCanopy(crops, rng, shape),
        conifer: species === 'conifer',
      });
    }
  };

  // --- conifers: the backbone of country and hills ----------------------
  if (atlas.conifer) {
    const tex = asTexture(atlas.conifer);
    add('conifer', atlas.conifer, CONIFER_SPRAYS, tex, [
      { cards: 200, radius: 0.3, taper: 1.15, cardSize: 0.26, conifer: true },
      { cards: 170, radius: 0.34, taper: 1.0, cardSize: 0.29, conifer: true },
      { cards: 230, radius: 0.28, taper: 1.3, cardSize: 0.23, conifer: true },
      { cards: 155, radius: 0.38, taper: 0.85, cardSize: 0.32, conifer: true },
      { cards: 190, radius: 0.32, taper: 1.05, cardSize: 0.27, conifer: true },
    ]);
  }

  // --- broadleaf species ---------------------------------------------------
  if (atlas.broadleaf) {
    const tex = asTexture(atlas.broadleaf);
    add('broadleaf', atlas.broadleaf, BROADLEAF_SPRIGS, tex, [
      { cards: 420, radius: 0.36, cardSize: 0.115, conifer: false, taper: 1 },
      { cards: 340, radius: 0.31, cardSize: 0.105, conifer: false, taper: 1 },
      { cards: 500, radius: 0.4, cardSize: 0.125, conifer: false, taper: 1 },
    ]);
    // Low, wide scrub for verges and paddy bunds.
    add('bush', atlas.broadleaf, BROADLEAF_SPRIGS, tex, [
      { cards: 150, radius: 0.5, cardSize: 0.2, conifer: false, shape: 'bush' },
      { cards: 110, radius: 0.42, cardSize: 0.22, conifer: false, shape: 'bush' },
    ]);
  }

  if (atlas.oak) {
    const tex = asTexture(atlas.oak);
    add('oak', atlas.oak, OAK_LEAVES, tex, [
      { cards: 460, radius: 0.4, cardSize: 0.1, conifer: false, taper: 1 },
      { cards: 380, radius: 0.34, cardSize: 0.095, conifer: false, taper: 1 },
    ]);
    // Jungle canopy: the same leaves, far denser and wider.
    add('jungle', atlas.oak, OAK_LEAVES, tex, [
      { cards: 620, radius: 0.46, cardSize: 0.12, conifer: false, taper: 1 },
      { cards: 540, radius: 0.5, cardSize: 0.13, conifer: false, taper: 1 },
    ]);
  }

  if (atlas.maple) {
    const tex = asTexture(atlas.maple);
    add('maple', atlas.maple, MAPLE_LEAVES, tex, [
      { cards: 430, radius: 0.38, cardSize: 0.105, conifer: false, taper: 1 },
      { cards: 360, radius: 0.33, cardSize: 0.1, conifer: false, taper: 1 },
    ]);

  }

  // Palms were tried and dropped: the only blade atlas available makes a
  // starburst of spikes rather than a frond, and there is no CC0 palm source.
  // Jungle and coast use the dense broadleaf canopies instead.

  return variants;
}

/**
 * Turf: a small cloud of grass-blade cards, scattered densely beside the road.
 * Ground texture alone reads as painted-on at this speed; actual blades
 * catching the light are what sell it.
 */
export function buildGrassTuft(atlas: FoliageAtlas, rng: Rng): TreeVariant | null {
  if (!atlas.blade) return null;
  const tex = new THREE.CanvasTexture(atlas.blade);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return {
    species: 'bush',
    radius: 0.42,
    texture: tex,
    // Blade crops are about 9:1, so the card's height is nine times its
    // width - a cardSize near 1 gives six-metre grass.
    geometry: buildCanopy(BLADES, rng, {
      cards: 7,
      conifer: false,
      radius: 0.3,
      cardSize: 0.1,
      baseY: 0,
      shape: 'bush',
    }),
    conifer: false,
  };
}

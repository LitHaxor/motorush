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
      console.warn('[roadbrush] foliage atlas unavailable', err);
      return null;
    }
  };
  const [conifer, broadleaf] = await Promise.all([
    grab('/textures/conifer_color.png', '/textures/conifer_alpha.png'),
    grab('/textures/broadleaf_color.png', '/textures/broadleaf_alpha.png'),
  ]);
  return { conifer, broadleaf };
}

/** Where each usable sprig sits in its atlas, in 0..1 coordinates. */
const CONIFER_SPRAYS = [
  { x: 0.23, y: 0.03, w: 0.73, h: 0.24 },
  { x: 0.01, y: 0.26, w: 0.98, h: 0.35 },
  { x: 0.0, y: 0.62, w: 0.99, h: 0.35 },
];

const BROADLEAF_SPRIGS = [
  { x: 0.0, y: 0.05, w: 0.34, h: 0.9 },
  { x: 0.33, y: 0.05, w: 0.22, h: 0.75 },
  { x: 0.55, y: 0.03, w: 0.22, h: 0.82 },
  { x: 0.76, y: 0.05, w: 0.23, h: 0.78 },
];

export interface TreeVariant {
  texture: THREE.CanvasTexture;
  /** Height/width ratio, used to shape the billboard planes. */
  aspect: number;
  conifer: boolean;
}

/**
 * Composite one tree from an atlas. `spread` controls how wide the crown is,
 * `tiers` how many layers of branches, `taper` how sharply it narrows.
 */
function compositeConifer(
  atlas: HTMLCanvasElement,
  rng: Rng,
  { width = 384, height = 640, tiers = 22, spread = 0.54, taper = 1.15 } = {},
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');

  const aw = atlas.width;
  const ah = atlas.height;
  const cx = width / 2;

  // Trunk first, so the canopy covers it rather than the other way round.
  ctx.strokeStyle = '#3b2e21';
  ctx.lineCap = 'round';
  ctx.lineWidth = width * 0.05;
  ctx.beginPath();
  ctx.moveTo(cx, height);
  ctx.lineTo(cx, height * 0.12);
  ctx.stroke();

  /** Draw one spray, both sides, at a given tier. */
  const layer = (y: number, half: number, droop: number, alpha: number, scale: number) => {
    const spray = CONIFER_SPRAYS[Math.floor(rng() * CONIFER_SPRAYS.length)];
    const sx = spray.x * aw;
    const sy = spray.y * ah;
    const sw = spray.w * aw;
    const sh = spray.h * ah;
    const w = half * scale;
    // Keep the branch's own proportions so the needles do not smear.
    const h = Math.max(26, (w / sw) * sh * 1.9);
    ctx.globalAlpha = alpha;
    for (const side of [1, -1]) {
      ctx.save();
      ctx.translate(cx, y);
      ctx.scale(side, 1);
      ctx.rotate(droop);
      ctx.drawImage(atlas, sx, sy, sw, sh, -w * 0.12, -h / 2, w, h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  };

  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1); // 0 at the base
    const y = height * (0.95 - t * 0.9);
    const half = width * spread * Math.pow(1 - t, taper) + width * 0.05;
    const droopBase = 0.16 + (1 - t) * 0.16;

    // Three overlapping sprays per tier at slightly different angles: one
    // spray per tier leaves gaps you can see daylight through.
    layer(y + half * 0.06, half, droopBase + 0.1, 1, 1.0);
    layer(y, half, droopBase, 1, 0.86);
    layer(y - half * 0.05, half, droopBase - 0.07, 0.95, 0.66);
  }

  // Leader: one small spray standing upright at the very top.
  const tip = CONIFER_SPRAYS[0];
  ctx.save();
  ctx.translate(cx, height * 0.05);
  ctx.rotate(-Math.PI / 2);
  const th = width * 0.3;
  ctx.drawImage(
    atlas, tip.x * aw, tip.y * ah, tip.w * aw, tip.h * ah,
    -th * 0.5, -th * 0.3, th * 1.3, th * 0.6,
  );
  ctx.restore();

  return c;
}

function compositeBroadleaf(
  atlas: HTMLCanvasElement,
  rng: Rng,
  { width = 448, height = 512, clumps = 150, spread = 0.44 } = {},
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');

  const aw = atlas.width;
  const ah = atlas.height;
  const cx = width / 2;
  const cy = height * 0.36;
  const rx = width * spread;
  const ry = height * 0.33;

  // Trunk and limbs FIRST, so the canopy buries them. Drawn on top they read
  // as black sticks poking through the leaves.
  ctx.strokeStyle = '#4a3a2b';
  ctx.lineCap = 'round';
  ctx.lineWidth = width * 0.05;
  ctx.beginPath();
  ctx.moveTo(cx, height);
  ctx.lineTo(cx, cy + ry * 0.5);
  ctx.stroke();
  ctx.lineWidth = width * 0.02;
  for (const dir of [-1, 1, -0.4, 0.4]) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + ry * 0.7);
    ctx.lineTo(cx + dir * rx * 0.5, cy - ry * 0.25);
    ctx.stroke();
  }

  // Scatter leaves through an ellipse to build the crown. Two passes: a dark
  // underlayer for depth, then the lit canopy over it.
  const scatter = (count: number, darken: number, sizeScale: number) => {
    ctx.globalAlpha = darken < 1 ? 0.9 : 1;
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * 0.98;
      const x = cx + Math.cos(a) * rx * r;
      const y = cy + Math.sin(a) * ry * r;
      const leaf = BROADLEAF_SPRIGS[Math.floor(rng() * BROADLEAF_SPRIGS.length)];
      const size = width * (0.2 + rng() * 0.16) * (1.15 - r * 0.28) * sizeScale;
      const lh = (size / (leaf.w * aw)) * (leaf.h * ah);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rng() * Math.PI * 2);
      if (darken < 1) ctx.filter = `brightness(${darken})`;
      ctx.drawImage(
        atlas, leaf.x * aw, leaf.y * ah, leaf.w * aw, leaf.h * ah,
        -size / 2, -lh / 2, size, lh,
      );
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
  };

  scatter(Math.round(clumps * 0.55), 0.62, 1.1);
  scatter(clumps, 1, 1);

  return c;
}

/** Build a set of tree billboards from the atlases. */
export function buildTreeVariants(atlas: FoliageAtlas, rng: Rng): TreeVariant[] {
  const variants: TreeVariant[] = [];

  if (atlas.conifer) {
    // Eight conifer silhouettes: tall and narrow through to short and broad.
    const shapes = [
      { tiers: 24, spread: 0.53, taper: 1.2, height: 704 },
      { tiers: 22, spread: 0.54, taper: 1.15, height: 640 },
      { tiers: 19, spread: 0.6, taper: 1.0, height: 576 },
      { tiers: 26, spread: 0.52, taper: 1.25, height: 768 },
      { tiers: 17, spread: 0.64, taper: 0.9, height: 512 },
      { tiers: 23, spread: 0.51, taper: 1.25, height: 672 },
      { tiers: 15, spread: 0.66, taper: 0.85, height: 448 },
      { tiers: 20, spread: 0.56, taper: 1.05, height: 608 },
    ];
    for (const shape of shapes) {
      const canvas = compositeConifer(atlas.conifer, rng, { width: 384, ...shape });
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      variants.push({ texture: tex, aspect: canvas.height / canvas.width, conifer: true });
    }
  }

  if (atlas.broadleaf) {
    const shapes = [
      { clumps: 150, spread: 0.46, height: 512 },
      { clumps: 120, spread: 0.4, height: 480 },
      { clumps: 180, spread: 0.49, height: 544 },
      { clumps: 100, spread: 0.36, height: 448 },
    ];
    for (const shape of shapes) {
      const canvas = compositeBroadleaf(atlas.broadleaf, rng, { width: 448, ...shape });
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      variants.push({ texture: tex, aspect: canvas.height / canvas.width, conifer: false });
    }
  }

  return variants;
}

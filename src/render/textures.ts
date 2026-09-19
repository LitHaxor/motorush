// Every texture in the game is drawn into a canvas at runtime. No binary assets
// means no loading screen, no CDN round-trips and a tiny deploy.

import * as THREE from 'three';

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

interface FinishOpts {
  repeatX?: number;
  repeatY?: number;
  aniso?: number;
}

function finish(c: HTMLCanvasElement, { repeatX = 1, repeatY = 1, aniso = 8 }: FinishOpts = {}): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = aniso;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function grain(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Lane markings only, on a transparent background. Painted onto its own ribbon
 * just above the asphalt so the lines stay crisp while the PBR road texture
 * underneath tiles at its own (much smaller) real-world scale.
 *
 * Spans the full road width and the same distance of track, so it tiles once
 * per dash cycle (3 m stripe + 6 m gap, twice over 18 m).
 */
export function makeMarkingsTexture({ size = 1024, halfWidth = 9 } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  const width = halfWidth * 2;
  const pxPerM = size / width;
  const toX = (lateral: number) => (lateral + halfWidth) * pxPerM;

  const line = (lateral: number, widthM: number, color: string, dash: number[] | null = null) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = widthM * pxPerM;
    ctx.setLineDash(dash ? dash.map((d) => d * pxPerM) : []);
    ctx.beginPath();
    ctx.moveTo(toX(lateral), 0);
    ctx.lineTo(toX(lateral), size);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  ctx.globalAlpha = 0.9;
  line(-halfWidth + 0.35, 0.16, '#e8e8e0'); // left edge
  line(halfWidth - 0.35, 0.16, '#e8e8e0'); // right edge
  line(-4.5, 0.14, '#d8d8d0', [3, 6]); // lane divider (oncoming side)
  line(4.5, 0.14, '#d8d8d0', [3, 6]); // lane divider (our side)
  // Double yellow down the middle: oncoming traffic lives to the left of it.
  line(-0.22, 0.13, '#d8b132');
  line(0.22, 0.13, '#d8b132');
  ctx.globalAlpha = 1;

  const tex = finish(c, { aniso: 16 });
  tex.premultiplyAlpha = false;
  return tex;
}

/** Procedural asphalt, used when the downloaded PBR set is unavailable. */
export function makeRoadTexture({ size = 512 } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#2e3033';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 220; i++) {
    const r = 8 + Math.random() * 60;
    ctx.globalAlpha = 0.04 + Math.random() * 0.06;
    ctx.fillStyle = Math.random() > 0.5 ? '#3c4045' : '#232528';
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  grain(ctx, size, size, 26);
  return finish(c, { aniso: 16 });
}

export function makeGroundTexture({ size = 512, base = '#4a5c33', accent = '#3a4a28' } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    ctx.globalAlpha = 0.05 + Math.random() * 0.15;
    ctx.fillStyle = Math.random() > 0.5 ? accent : '#5d7040';
    const r = 4 + Math.random() * 26;
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  grain(ctx, size, size, 30);
  return finish(c, { repeatX: 4, repeatY: 4 });
}

export function makeDirtTexture({ size = 512 } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#6b5b45';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 1200; i++) {
    ctx.globalAlpha = 0.06 + Math.random() * 0.18;
    ctx.fillStyle = Math.random() > 0.5 ? '#7d6c52' : '#564a39';
    const r = 2 + Math.random() * 14;
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  grain(ctx, size, size, 34);
  return finish(c, { repeatX: 1, repeatY: 1 });
}

export function makeCheckerTexture({ size = 256, squares = 8 } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  const step = size / squares;
  for (let y = 0; y < squares; y++) {
    for (let x = 0; x < squares; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#101010' : '#f5f5f5';
      ctx.fillRect(x * step, y * step, step, step);
    }
  }
  return finish(c);
}

/** Roadside billboard / sponsor board. */
export function makeSignTexture(
  text: string,
  { bg = '#13161d', fg = '#ff5a1f', size = 512 } = {},
): THREE.CanvasTexture {
  const c = canvas(size, Math.floor(size / 2));
  const ctx = ctx2d(c);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 8;
  ctx.strokeRect(12, 12, c.width - 24, c.height - 24);
  ctx.fillStyle = fg;
  ctx.font = `bold ${Math.floor(c.height * 0.3)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2);
  return finish(c);
}

/** Soft radial blob used for particles, glows and headlights. */
export function makeGlowTexture({ size = 128, color = '255,180,90' } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, `rgba(${color},1)`);
  g.addColorStop(0.35, `rgba(${color},0.55)`);
  g.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Building facade: a grid of windows over a base wall, with shopfronts along
 * the ground floor. `floors` and `bays` control the window grid so the texture
 * can be sized to the building's proportions.
 */
export function makeFacadeTexture({
  size = 256,
  floors = 8,
  bays = 5,
  wall = '#6d6257',
  trim = '#4a423a',
  litChance = 0.35,
}: {
  size?: number;
  floors?: number;
  bays?: number;
  wall?: string;
  trim?: string;
  litChance?: number;
} = {}): THREE.CanvasTexture {
  const h = size * 2;
  const c = canvas(size, h);
  const ctx = ctx2d(c);

  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, size, h);

  // Subtle vertical banding so flat walls are not dead flat.
  for (let i = 0; i < 40; i++) {
    ctx.globalAlpha = 0.03 + Math.random() * 0.05;
    ctx.fillStyle = Math.random() > 0.5 ? '#ffffff' : '#000000';
    ctx.fillRect(Math.random() * size, 0, 4 + Math.random() * 22, h);
  }
  ctx.globalAlpha = 1;

  const groundH = h / (floors + 1.6);
  const upper = h - groundH;
  const floorH = upper / floors;
  const bayW = size / bays;

  // Upper floors: window grid.
  for (let f = 0; f < floors; f++) {
    for (let b = 0; b < bays; b++) {
      const x = b * bayW + bayW * 0.22;
      const y = f * floorH + floorH * 0.22;
      const w = bayW * 0.56;
      const wh = floorH * 0.56;
      const lit = Math.random() < litChance;
      ctx.fillStyle = lit ? '#ffd98a' : '#1b2027';
      ctx.fillRect(x, y, w, wh);
      ctx.strokeStyle = trim;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, wh);
      if (lit) {
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = '#ffeec2';
        ctx.fillRect(x - 2, y - 2, w + 4, wh + 4);
        ctx.globalAlpha = 1;
      }
    }
  }

  // Ground floor: shopfronts and a cornice line.
  ctx.fillStyle = trim;
  ctx.fillRect(0, upper - 4, size, 6);
  for (let b = 0; b < bays; b++) {
    const x = b * bayW + bayW * 0.1;
    const w = bayW * 0.8;
    ctx.fillStyle = Math.random() < 0.5 ? '#26303c' : '#2f2a33';
    ctx.fillRect(x, upper + groundH * 0.18, w, groundH * 0.6);
    ctx.fillStyle = ['#c8503c', '#3c7cc8', '#c8a33c', '#4aa06a'][Math.floor(Math.random() * 4)];
    ctx.fillRect(x, upper + groundH * 0.08, w, groundH * 0.12);
  }

  grain(ctx, size, h, 16);
  return finish(c, { aniso: 8 });
}

/**
 * W-beam guardrail. The U axis runs across the rail's height, so the banding
 * here becomes the horizontal fold of the beam.
 */
export function makeGuardrailTexture({ size = 64 } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  const band = (from: number, to: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.fillRect(from * size, 0, (to - from) * size, size);
  };
  band(0, 1, '#9aa0a6');
  band(0, 0.12, '#6f767d'); // shadowed lower lip
  band(0.12, 0.42, '#b9bfc5');
  band(0.42, 0.58, '#6b7278'); // the central fold
  band(0.58, 0.88, '#b9bfc5');
  band(0.88, 1, '#7c838a');
  // Streaks of road grime along the length.
  for (let i = 0; i < 26; i++) {
    ctx.globalAlpha = 0.05 + Math.random() * 0.12;
    ctx.fillStyle = Math.random() > 0.5 ? '#5a5f64' : '#d6dade';
    ctx.fillRect(0, Math.random() * size, size, 1 + Math.random() * 2);
  }
  ctx.globalAlpha = 1;
  grain(ctx, size, size, 14);
  return finish(c, { aniso: 8 });
}

/** Zebra crossing: bars running along the U axis, across the road. */
export function makeZebraTexture({ size = 256, bars = 9 } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  const step = size / bars;
  for (let i = 0; i < bars; i++) {
    // Leave the outer bars off so the crossing stops short of the kerb.
    if (i === 0 || i === bars - 1) continue;
    if (i % 2 === 0) continue;
    ctx.fillStyle = 'rgba(240,240,235,0.92)';
    ctx.fillRect(i * step, size * 0.06, step * 0.62, size * 0.88);
  }
  const tex = finish(c, { aniso: 8 });
  tex.premultiplyAlpha = false;
  return tex;
}

// ============================ rider + bike ============================
// Riders and bikes are the only things the camera ever looks at closely, so
// they get proper panelled liveries rather than flat colours.

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

function shade(color: number, amount: number): string {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  const f = (v: number) =>
    Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/**
 * Racing leathers. The U axis wraps around the limb/torso, so vertical bands
 * here become stripes running down the outside of the suit.
 */
export function makeLeatherTexture(base: number, accent: number, { size = 512 } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);

  ctx.fillStyle = hex(base);
  ctx.fillRect(0, 0, size, size);

  // Broad accent flash down one side of the suit.
  ctx.fillStyle = hex(accent);
  ctx.fillRect(size * 0.06, 0, size * 0.16, size);
  ctx.fillStyle = shade(accent, -0.35);
  ctx.fillRect(size * 0.22, 0, size * 0.05, size);

  // Thin twin stripes down the other side.
  ctx.fillStyle = '#f2f2f0';
  ctx.fillRect(size * 0.62, 0, size * 0.045, size);
  ctx.fillRect(size * 0.69, 0, size * 0.025, size);

  // Horizontal panel seams - these become rings around the limbs.
  ctx.strokeStyle = shade(base, -0.5);
  ctx.lineWidth = 3;
  for (const y of [0.2, 0.44, 0.62, 0.84]) {
    ctx.beginPath();
    ctx.moveTo(0, y * size);
    ctx.lineTo(size, y * size);
    ctx.stroke();
  }

  // Quilted armour block across the back/shoulders.
  ctx.fillStyle = shade(base, -0.3);
  ctx.fillRect(size * 0.3, size * 0.2, size * 0.28, size * 0.24);
  ctx.strokeStyle = shade(base, -0.55);
  ctx.lineWidth = 2;
  for (let i = 1; i < 4; i++) {
    const y = size * 0.2 + (size * 0.24 * i) / 4;
    ctx.beginPath();
    ctx.moveTo(size * 0.3, y);
    ctx.lineTo(size * 0.58, y);
    ctx.stroke();
  }

  // Sponsor block.
  ctx.fillStyle = '#0e1116';
  ctx.fillRect(size * 0.34, size * 0.5, size * 0.2, size * 0.075);
  ctx.fillStyle = '#e8e8e2';
  ctx.font = `bold ${Math.floor(size * 0.05)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('RB', size * 0.44, size * 0.539);

  grain(ctx, size, size, 12);
  return finish(c, { aniso: 8 });
}

/** Helmet: a shell colour, a stripe over the crown and a dark visor band. */
export function makeHelmetTexture(base: number, accent: number, { size = 256 } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  ctx.fillStyle = hex(base);
  ctx.fillRect(0, 0, size, size);

  // Stripe over the crown (V runs pole to pole on a sphere).
  ctx.fillStyle = hex(accent);
  ctx.fillRect(size * 0.42, 0, size * 0.16, size);
  ctx.fillStyle = '#f4f4f0';
  ctx.fillRect(size * 0.585, 0, size * 0.04, size);

  // Visor band around the equator.
  const vTop = size * 0.4;
  const vH = size * 0.2;
  const grad = ctx.createLinearGradient(0, vTop, 0, vTop + vH);
  grad.addColorStop(0, '#0a0e14');
  grad.addColorStop(0.5, '#1d2b3d');
  grad.addColorStop(1, '#070a0f');
  ctx.fillStyle = grad;
  ctx.fillRect(0, vTop, size, vH);
  ctx.fillStyle = shade(base, -0.55);
  ctx.fillRect(0, vTop - size * 0.02, size, size * 0.02);
  ctx.fillRect(0, vTop + vH, size, size * 0.02);

  grain(ctx, size, size, 8);
  return finish(c, { aniso: 8 });
}

/** Glossy bike bodywork: accent flash, number roundel and panel shading. */
export function makeBikePaintTexture(base: number, accent: number, { size = 512 } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  ctx.fillStyle = hex(base);
  ctx.fillRect(0, 0, size, size);

  // Diagonal accent sweep.
  ctx.save();
  ctx.translate(size * 0.5, size * 0.5);
  ctx.rotate(-0.42);
  ctx.fillStyle = hex(accent);
  ctx.fillRect(-size, -size * 0.14, size * 2, size * 0.2);
  ctx.fillStyle = '#101319';
  ctx.fillRect(-size, size * 0.07, size * 2, size * 0.05);
  ctx.restore();

  // Number roundel.
  ctx.fillStyle = '#f0f0ea';
  ctx.beginPath();
  ctx.arc(size * 0.68, size * 0.36, size * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#14171d';
  ctx.font = `bold ${Math.floor(size * 0.15)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('7', size * 0.68, size * 0.37);

  // A soft highlight so flat panels read as glossy.
  const gloss = ctx.createLinearGradient(0, 0, 0, size);
  gloss.addColorStop(0, 'rgba(255,255,255,0.22)');
  gloss.addColorStop(0.45, 'rgba(255,255,255,0.03)');
  gloss.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 0, size, size);

  grain(ctx, size, size, 8);
  return finish(c, { aniso: 8 });
}

/** Tyre sidewall + tread blocks. */
export function makeTyreTexture({ size = 256 } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#16171a';
  ctx.fillRect(0, 0, size, size);
  // Tread grooves run around the circumference.
  ctx.strokeStyle = '#0a0b0d';
  ctx.lineWidth = size * 0.035;
  for (let i = 0; i < 26; i++) {
    const y = (i / 26) * size;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + size * 0.06);
    ctx.stroke();
  }
  ctx.strokeStyle = '#2a2c31';
  ctx.lineWidth = 2;
  ctx.strokeRect(size * 0.02, 0, size * 0.96, size);
  grain(ctx, size, size, 10);
  return finish(c, { aniso: 8 });
}

/** Soft elliptical blob for contact shadows under the wheels. */
export function makeContactShadowTexture({ size = 128 } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.75)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.38)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Conifer foliage for crossed billboard planes.
 *
 * Each tier is laid down as a solid wedge first and only then detailed with
 * needle sprays. Drawing the sprays alone leaves a spindly skeleton once the
 * alpha test bites, because thin antialiased strokes are mostly partial alpha.
 */
export function makeConiferTexture({ width = 512, height = 768 } = {}): THREE.CanvasTexture {
  const c = canvas(width, height);
  const ctx = ctx2d(c);

  const DARK = '#1e3a22';
  const MID = '#2f5a33';
  const LIGHT = '#477a41';
  const TIP = '#67a052';

  const tiers = 13;
  const cx = width / 2;

  /** Solid wedge for one tier, giving the tree its mass. */
  const wedge = (y: number, half: number, drop: number, colour: string) => {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(cx, y - drop * 0.75);
    ctx.lineTo(cx - half, y + drop);
    // Ragged underside so the silhouette is not a clean triangle.
    const steps = 9;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const x = cx - half + half * 2 * f;
      const sag = Math.sin(f * Math.PI) * drop * 0.32;
      const jag = (i % 2 === 0 ? 1 : -1) * drop * 0.16;
      ctx.lineTo(x, y + drop - sag + jag);
    }
    ctx.closePath();
    ctx.fill();
  };

  /** Needle detail along a branch. */
  const spray = (x: number, y: number, len: number, dir: number, colour: string, thick: number) => {
    ctx.strokeStyle = colour;
    ctx.lineCap = 'round';
    const steps = Math.max(3, Math.floor(len / 9));
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const px = x + dir * len * f;
      const py = y + len * 0.36 * f;
      const nl = 5 + (1 - f) * 9;
      ctx.lineWidth = thick;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + dir * nl * 0.4, py + nl);
      ctx.stroke();
    }
  };

  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1); // 0 at the bottom
    const y = height * (0.95 - t * 0.88);
    const half = width * 0.46 * Math.pow(1 - t, 1.15) + width * 0.02;
    const drop = height * 0.055 * (1 - t * 0.45);

    // Back of the tier in shadow, front catching the light.
    wedge(y + drop * 0.35, half, drop, DARK);
    wedge(y, half * 0.9, drop * 0.92, MID);
    wedge(y - drop * 0.22, half * 0.66, drop * 0.78, LIGHT);

    // Needle detail out along the branches.
    const sprays = Math.max(3, Math.floor(half / 20));
    for (let s = 0; s < sprays; s++) {
      const f = (s + 0.5) / sprays;
      const len = half * (0.5 + f * 0.55);
      const yy = y + (Math.random() - 0.4) * drop * 0.5;
      spray(cx, yy, len, -1, DARK, 3);
      spray(cx, yy, len, 1, DARK, 3);
      spray(cx, yy - drop * 0.25, len * 0.8, -1, TIP, 2);
      spray(cx, yy - drop * 0.25, len * 0.8, 1, TIP, 2);
    }
  }

  // Leader at the very top.
  ctx.strokeStyle = MID;
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, height * 0.1);
  ctx.lineTo(cx, height * 0.025);
  ctx.stroke();

  // Bare trunk below the lowest branches.
  ctx.strokeStyle = '#3a2c1f';
  ctx.lineWidth = width * 0.04;
  ctx.beginPath();
  ctx.moveTo(cx, height);
  ctx.lineTo(cx, height * 0.88);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.premultiplyAlpha = false;
  return tex;
}

/** Bark for the trunk: vertical fissures in brown-grey. */
export function makeBarkTexture({ size = 256 } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#4a3a2c';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    ctx.globalAlpha = 0.1 + Math.random() * 0.35;
    ctx.strokeStyle = Math.random() > 0.5 ? '#2e241a' : '#63513e';
    ctx.lineWidth = 1 + Math.random() * 5;
    let x = Math.random() * size;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    for (let y = 0; y < size; y += 26) {
      x += (Math.random() - 0.5) * 9;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  grain(ctx, size, size, 20);
  return finish(c, { repeatX: 2, repeatY: 3 });
}

/** City pavement: concrete slabs with joints, and a kerb along one edge. */
export function makePavementTexture({ size = 512, slabs = 6 } = {}): THREE.CanvasTexture {
  const c = canvas(size, size);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#9a9791';
  ctx.fillRect(0, 0, size, size);

  // Slab-to-slab tonal variation.
  const step = size / slabs;
  for (let y = 0; y < slabs; y++) {
    for (let x = 0; x < slabs; x++) {
      ctx.globalAlpha = 0.05 + Math.random() * 0.12;
      ctx.fillStyle = Math.random() > 0.5 ? '#b3b0a9' : '#84817b';
      ctx.fillRect(x * step, y * step, step, step);
    }
  }
  ctx.globalAlpha = 1;

  // Joints between the slabs.
  ctx.strokeStyle = '#6d6a65';
  ctx.lineWidth = 3;
  for (let i = 1; i < slabs; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, size);
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step);
    ctx.stroke();
  }

  // Staining and a few cracks.
  for (let i = 0; i < 120; i++) {
    ctx.globalAlpha = 0.03 + Math.random() * 0.08;
    ctx.fillStyle = Math.random() > 0.5 ? '#6f6c67' : '#c2bfb8';
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, 4 + Math.random() * 26, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Kerb along the road edge (u = 0), lighter with a shadow line.
  ctx.fillStyle = '#c8c5be';
  ctx.fillRect(0, 0, size * 0.09, size);
  ctx.fillStyle = '#5f5c57';
  ctx.fillRect(size * 0.09, 0, size * 0.018, size);

  grain(ctx, size, size, 18);
  return finish(c, { repeatX: 1, repeatY: 1, aniso: 8 });
}

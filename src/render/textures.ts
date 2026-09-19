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

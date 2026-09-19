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

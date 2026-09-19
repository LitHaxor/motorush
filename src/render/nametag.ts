// Floating rider names.
//
// Deliberately quiet: pale grey, translucent, and gone at any distance. The
// point is to know which of the eight bikes is the friend who just knocked you
// off, not to plaster the road in labels.

import * as THREE from 'three';

/** Beyond this the tag is invisible; it fades out over the last stretch. */
const FADE_FROM = 55;
const FADE_TO = 75;
/** How far above the rider's head the tag floats, in metres. */
const HEIGHT = 1.62;

const FONT = '500 40px "Segoe UI", system-ui, -apple-system, sans-serif';
const PAD = 18;

export interface NameTag {
  sprite: THREE.Sprite;
  dispose(): void;
}

/**
 * Draw the name once into a canvas and hang it on a sprite.
 *
 * A sprite rather than 3D text so it always faces the camera without any
 * per-frame work, and one texture per rider is nothing next to the bikes.
 */
export function makeNameTag(name: string): NameTag {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  ctx.font = FONT;
  const width = Math.ceil(ctx.measureText(name).width) + PAD * 2;
  canvas.width = Math.max(2, width);
  canvas.height = 72;

  // Measuring resets the context, so the font has to be set again.
  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // A soft dark backing keeps pale names legible against sky and tarmac alike
  // without reading as a UI label stuck to the world.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 22;
  ctx.beginPath();
  ctx.rect(12, 14, canvas.width - 24, canvas.height - 30);
  ctx.stroke();
  ctx.fill();

  ctx.fillStyle = 'rgba(176, 178, 182, 0.85)';
  ctx.fillText(name, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    // Drawn over the bikes rather than poking through them: a name clipped in
    // half by its own rider's helmet looks like a bug.
    depthTest: false,
    // Never brighter than the scene around it.
    toneMapped: true,
  });

  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 10;
  // Height in metres. A rider is about 1.8m, so this is a tag roughly the
  // size of their head - the first cut was 0.9 and read as a billboard
  // plastered across the road.
  const scale = 0.34;
  sprite.scale.set((canvas.width / canvas.height) * scale, scale, 1);
  sprite.position.y = HEIGHT;
  sprite.visible = false;

  return {
    sprite,
    dispose() {
      texture.dispose();
      material.dispose();
    },
  };
}

/** How opaque a tag should be at this distance. 0 means do not draw it. */
export function tagOpacity(distance: number): number {
  if (distance >= FADE_TO) return 0;
  if (distance <= FADE_FROM) return 1;
  return 1 - (distance - FADE_FROM) / (FADE_TO - FADE_FROM);
}

/** Point the tag at the camera and fade it for distance. */
export function updateNameTag(tag: NameTag, distance: number, show: boolean): void {
  const opacity = show ? tagOpacity(distance) : 0;
  tag.sprite.visible = opacity > 0.01;
  (tag.sprite.material as THREE.SpriteMaterial).opacity = opacity * 0.5;
}

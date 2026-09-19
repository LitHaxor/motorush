// Particles and camera shake. One pooled Points cloud covers sparks, dust and
// debris, so the whole FX layer is a single draw call.

import * as THREE from 'three';
import { makeGlowTexture } from './textures';
import { clamp } from '../sim/mathx';

const MAX_PARTICLES = 700;
const GRAVITY = -16;

interface Particle {
  life: number;
  maxLife: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  drag: number;
}

export class ParticleField {
  readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  /** Colour a particle was emitted with, before life fading. */
  private readonly baseColors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly pool: Particle[] = [];
  private cursor = 0;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;
  private readonly texture: THREE.Texture;

  constructor() {
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.baseColors = new Float32Array(MAX_PARTICLES * 3);
    this.sizes = new Float32Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool.push({ life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0, size: 1, drag: 1.5 });
      // Park dead particles far below the world rather than at the origin.
      this.positions[i * 3 + 1] = -9999;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.texture = makeGlowTexture({ color: '255,220,160' });
    this.material = new THREE.PointsMaterial({
      size: 0.5,
      map: this.texture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }

  private emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    color: THREE.Color, life: number, size: number, drag: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    const p = this.pool[i];
    p.life = life;
    p.maxLife = life;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.size = size;
    p.drag = drag;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.colors[i * 3] = color.r;
    this.colors[i * 3 + 1] = color.g;
    this.colors[i * 3 + 2] = color.b;
    this.baseColors[i * 3] = color.r;
    this.baseColors[i * 3 + 1] = color.g;
    this.baseColors[i * 3 + 2] = color.b;
    this.sizes[i] = size;
  }

  /** Bright metal-on-tarmac sparks from a crash or a heavy hit. */
  sparks(at: THREE.Vector3, count = 22, tint = 0xffb347): void {
    const color = new THREE.Color(tint);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 3 + Math.random() * 11;
      this.emit(
        at.x, at.y, at.z,
        Math.cos(a) * speed, 2 + Math.random() * 7, Math.sin(a) * speed,
        color, 0.32 + Math.random() * 0.45, 0.16 + Math.random() * 0.2, 2.2,
      );
    }
  }

  /** Dust kicked up by a wheel on dirt. */
  dust(at: THREE.Vector3, count = 3, tint = 0xb09878): void {
    const color = new THREE.Color(tint);
    for (let i = 0; i < count; i++) {
      this.emit(
        at.x + (Math.random() - 0.5) * 0.6, at.y + 0.1, at.z + (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 2.4, 0.9 + Math.random() * 2.2, (Math.random() - 0.5) * 2.4,
        color, 0.55 + Math.random() * 0.5, 0.45 + Math.random() * 0.55, 1.1,
      );
    }
  }

  /** Warm puff when a pickup is collected. */
  burst(at: THREE.Vector3, tint: number, count = 16): void {
    const color = new THREE.Color(tint);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 5;
      this.emit(
        at.x, at.y, at.z,
        Math.cos(a) * speed, 1.5 + Math.random() * 4, Math.sin(a) * speed,
        color, 0.45 + Math.random() * 0.35, 0.3 + Math.random() * 0.3, 1.8,
      );
    }
  }

  update(dt: number): void {
    const pos = this.positions;
    const sizes = this.sizes;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.pool[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        pos[i * 3 + 1] = -9999;
        sizes[i] = 0;
        continue;
      }
      const decay = Math.exp(-p.drag * dt);
      p.vx *= decay;
      p.vz *= decay;
      p.vy = p.vy * decay + GRAVITY * dt;
      pos[i * 3] += p.vx * dt;
      pos[i * 3 + 1] += p.vy * dt;
      pos[i * 3 + 2] += p.vz * dt;
      // PointsMaterial takes a single uniform size, so there is no per-point
      // size to animate; fade the colour instead - under additive blending
      // that reads as the particle burning out.
      const k = p.life / p.maxLife;
      const c = this.baseColors;
      this.colors[i * 3] = c[i * 3] * k;
      this.colors[i * 3 + 1] = c[i * 3 + 1] * k;
      this.colors[i * 3 + 2] = c[i * 3 + 2] * k;
      sizes[i] = p.size * k;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.attributes.size.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/** Trauma-based camera shake: add trauma on impact, it decays on its own. */
export class CameraShake {
  private trauma = 0;
  private time = 0;

  add(amount: number): void {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  update(dt: number): void {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 0.85);
  }

  /** Squared trauma gives a punchier falloff than linear. */
  get amount(): number {
    return this.trauma * this.trauma;
  }

  offset(out: THREE.Vector3): THREE.Vector3 {
    const a = this.amount;
    if (a <= 0) return out.set(0, 0, 0);
    const t = this.time * 34;
    return out.set(
      Math.sin(t * 1.7) * a * 0.55,
      Math.sin(t * 2.3 + 1.1) * a * 0.42,
      Math.sin(t * 1.3 + 2.4) * a * 0.3,
    );
  }

  get roll(): number {
    return Math.sin(this.time * 27) * this.amount * 0.06;
  }

  reset(): void {
    this.trauma = 0;
  }
}

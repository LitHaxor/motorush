// Sky dome. A single inverted sphere with a gradient + sun + cheap procedural
// cloud band, parented to the camera so it never gets closer.

import * as THREE from 'three';
import type { SkyPreset } from './palette';

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uHaze;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform vec3 uCloudColor;
  uniform float uCloudAmount;
  uniform float uTime;

  // Cheap value noise - enough for a soft cloud band, no texture needed.
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
    return v;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = clamp(dir.y, -1.0, 1.0);

    // Vertical gradient: haze at the horizon easing up into the zenith.
    float t = pow(clamp(h * 1.15 + 0.08, 0.0, 1.0), 0.62);
    vec3 col = mix(uHorizon, uZenith, t);
    col = mix(uHaze, col, smoothstep(-0.02, 0.28, h));

    // Sun disc + broad glow.
    float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
    col += uSunColor * pow(sunDot, 480.0) * 6.0;
    col += uSunColor * pow(sunDot, 7.0) * 0.32;

    // Clouds drift slowly across the upper hemisphere.
    if (h > 0.02) {
      vec2 uv = dir.xz / max(dir.y, 0.12) * 0.55 + vec2(uTime * 0.004, uTime * 0.002);
      float c = fbm(uv * 1.6);
      c = smoothstep(0.52, 0.86, c) * uCloudAmount * smoothstep(0.02, 0.3, h);
      col = mix(col, uCloudColor, c);
    }

    // Linear HDR out: OutputPass applies tone mapping and colour space.
    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface SkyHandle {
  mesh: THREE.Mesh;
  update(time: number): void;
  dispose(): void;
}

export function createSky(preset: SkyPreset, radius = 4000): SkyHandle {
  const uniforms = {
    uZenith: { value: new THREE.Color(preset.zenith) },
    uHorizon: { value: new THREE.Color(preset.horizon) },
    uHaze: { value: new THREE.Color(preset.haze) },
    uSunColor: { value: new THREE.Color(preset.sun) },
    uSunDir: { value: new THREE.Vector3(...preset.sunDir).normalize() },
    uCloudColor: { value: new THREE.Color(preset.cloud) },
    uCloudAmount: { value: preset.cloudAmount },
    uTime: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 20), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.name = 'sky';

  return {
    mesh,
    update(time: number) {
      uniforms.uTime.value = time;
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}

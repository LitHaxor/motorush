// The motorcycle: a sportbike silhouette built from primitives and merged down
// to a handful of draw calls per material.
//
// Authored facing -Z, same as everything else, so `root.rotation.y = heading`
// lines it up with the track. Wheels and the steering head stay separate so
// they can turn; everything else is one rigid shell that leans, dives and -
// when it all goes wrong - tumbles down the road on its own.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeBikePaintTexture, makeTyreTexture, makeGlowTexture, makeContactShadowTexture } from './textures';
import type { RacerKind } from '../sim/types';

type MatKey = 'paint' | 'dark' | 'chrome' | 'rim' | 'accentPlastic';

interface Piece {
  geo: THREE.BufferGeometry;
  mat: MatKey;
}

/** Collects primitives, positions them, and merges by material at the end. */
class Builder {
  private readonly pieces: Piece[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);

  add(
    geo: THREE.BufferGeometry,
    mat: MatKey,
    pos: [number, number, number],
    rot: [number, number, number] = [0, 0, 0],
    scale: [number, number, number] = [1, 1, 1],
  ): void {
    this.v.set(...pos);
    this.e.set(...rot);
    this.q.setFromEuler(this.e);
    this.s.set(...scale);
    this.m.compose(this.v, this.q, this.s);
    geo.applyMatrix4(this.m);
    this.pieces.push({ geo, mat });
  }

  /** Merge into one geometry per material. */
  build(): Map<MatKey, THREE.BufferGeometry> {
    const byMat = new Map<MatKey, THREE.BufferGeometry[]>();
    for (const p of this.pieces) {
      const list = byMat.get(p.mat) ?? [];
      list.push(p.geo);
      byMat.set(p.mat, list);
    }
    const out = new Map<MatKey, THREE.BufferGeometry>();
    for (const [mat, list] of byMat) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (merged) out.set(mat, merged);
    }
    return out;
  }
}

export interface BikeRig {
  root: THREE.Group;
  /** Carries lean and suspension pitch; the rider is NOT parented to this. */
  chassis: THREE.Group;
  /** Rotates with steering input. */
  steering: THREE.Group;
  frontWheel: THREE.Group;
  rearWheel: THREE.Group;
  /** Front fork travel, 0 extended .. 1 fully compressed. */
  setDive(amount: number): void;
  /** Blobs pinning the wheels to the road; hidden while airborne. */
  contactShadows: THREE.Mesh[];
  brakeLight: THREE.MeshStandardMaterial;
  headlight: THREE.Sprite;
  lightBar: THREE.Group | null;
  /** World-space seat position, where the rider sits. */
  readonly seatOffset: THREE.Vector3;
  dispose(): void;
}

const R_FRONT = 0.31;
const R_REAR = 0.31;
const FORK_ANGLE = 0.42; // rake, radians

export function createBikeRig(colour: number, kind: RacerKind = 'rival'): BikeRig {
  const root = new THREE.Group();
  const chassis = new THREE.Group();
  root.add(chassis);

  const isCop = kind === 'cop';
  const bodyColour = isCop ? 0xf2f4f7 : colour;
  const accent = isCop ? 0x16233d : 0x14171d;

  const paintTex = makeBikePaintTexture(bodyColour, accent);
  const tyreTex = makeTyreTexture();

  const materials: Record<MatKey, THREE.MeshStandardMaterial> = {
    paint: new THREE.MeshStandardMaterial({
      map: paintTex, roughness: 0.22, metalness: 0.45, envMapIntensity: 1.3,
    }),
    dark: new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.62, metalness: 0.4 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xccd2d8, roughness: 0.14, metalness: 1 }),
    rim: new THREE.MeshStandardMaterial({ color: 0x6e757e, roughness: 0.28, metalness: 0.92 }),
    accentPlastic: new THREE.MeshStandardMaterial({ color: accent, roughness: 0.4, metalness: 0.2 }),
  };
  const disposables: { dispose(): void }[] = [paintTex, tyreTex, ...Object.values(materials)];

  // ======================= chassis (merged) =========================
  // Real sportbike proportions: 1.40 m wheelbase, 0.83 m seat, 0.62 m wheels.
  // The bars and pegs sit exactly where the rider's hands and feet land, which
  // is what stops the two looking like they came from different models.
  const b = new Builder();

  // Engine, gearbox and cylinder head.
  b.add(new THREE.BoxGeometry(0.36, 0.34, 0.46), 'dark', [0, 0.46, 0.02]);
  b.add(new THREE.BoxGeometry(0.42, 0.18, 0.28), 'dark', [0, 0.36, -0.04]);
  for (let i = 0; i < 4; i++) {
    b.add(new THREE.BoxGeometry(0.4, 0.028, 0.24), 'chrome', [0, 0.58 + i * 0.04, -0.04]);
  }
  b.add(new THREE.BoxGeometry(0.3, 0.26, 0.05), 'dark', [0, 0.52, -0.26]);

  // Twin-spar frame from steering head to swingarm pivot.
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.06, 0.13, 0.6), 'rim', [sx * 0.19, 0.7, -0.12]);
  }

  // Fuel tank.
  b.add(new THREE.SphereGeometry(0.22, 14, 10), 'paint', [0, 0.78, -0.08], [0, 0, 0], [1, 0.58, 1.45]);
  b.add(new THREE.BoxGeometry(0.26, 0.09, 0.26), 'paint', [0, 0.81, 0.12]);

  // Seat and tail.
  b.add(new THREE.BoxGeometry(0.26, 0.07, 0.42), 'dark', [0, 0.82, 0.3]);
  b.add(new THREE.SphereGeometry(0.15, 12, 8), 'paint', [0, 0.88, 0.66], [0, 0, 0], [0.92, 0.7, 1.4]);
  b.add(new THREE.SphereGeometry(0.11, 10, 8), 'paint', [0, 0.97, 0.7], [0, 0, 0], [0.78, 0.85, 1.05]);

  // Nose fairing, side panels, belly pan.
  b.add(new THREE.ConeGeometry(0.21, 0.48, 12), 'paint', [0, 0.8, -0.6], [-Math.PI / 2, 0, 0]);
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.055, 0.32, 0.46), 'paint', [sx * 0.2, 0.64, -0.36], [0, sx * 0.14, 0]);
    b.add(new THREE.BoxGeometry(0.05, 0.18, 0.36), 'accentPlastic', [sx * 0.18, 0.4, -0.22], [0, sx * 0.1, 0]);
  }
  b.add(new THREE.BoxGeometry(0.32, 0.14, 0.26), 'accentPlastic', [0, 0.36, -0.28]);

  // Windscreen.
  b.add(new THREE.BoxGeometry(0.22, 0.18, 0.025), 'dark', [0, 1.02, -0.58], [0.72, 0, 0]);

  // Swingarm and rear shock.
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.055, 0.09, 0.56), 'rim', [sx * 0.14, 0.4, 0.42]);
  }
  b.add(new THREE.CylinderGeometry(0.032, 0.032, 0.26, 6), 'chrome', [0, 0.6, 0.28], [0.5, 0, 0]);

  // Exhaust: header tucking under the engine into a muffler on the right.
  b.add(new THREE.CylinderGeometry(0.04, 0.04, 0.46, 8), 'chrome', [0.08, 0.32, -0.06], [1.3, 0.2, 0]);
  b.add(new THREE.CylinderGeometry(0.065, 0.05, 0.42, 10), 'chrome', [0.16, 0.48, 0.6], [1.45, 0, 0]);

  // Clip-on bars, exactly under the rider's hands.
  for (const sx of [-1, 1]) {
    b.add(new THREE.CylinderGeometry(0.02, 0.02, 0.18, 6), 'chrome',
      [sx * 0.26, 0.96, -0.44], [0, 0, Math.PI / 2]);
    b.add(new THREE.CylinderGeometry(0.028, 0.028, 0.1, 6), 'dark',
      [sx * 0.33, 0.96, -0.44], [0, 0, Math.PI / 2]);
    // Mirror stalk + head.
    b.add(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 5), 'dark', [sx * 0.24, 1.04, -0.52]);
    b.add(new THREE.BoxGeometry(0.1, 0.05, 0.02), 'dark', [sx * 0.26, 1.1, -0.53], [0, sx * 0.3, 0]);
  }

  // Instrument binnacle.
  b.add(new THREE.BoxGeometry(0.18, 0.05, 0.1), 'dark', [0, 1.0, -0.48], [0.5, 0, 0]);

  // Footpegs, exactly under the rider's boots.
  for (const sx of [-1, 1]) {
    b.add(new THREE.CylinderGeometry(0.016, 0.016, 0.1, 6), 'chrome',
      [sx * 0.21, 0.35, 0.16], [0, 0, Math.PI / 2]);
    b.add(new THREE.BoxGeometry(0.03, 0.14, 0.1), 'rim', [sx * 0.17, 0.4, 0.16]);
  }

  const merged = b.build();
  for (const [key, geo] of merged) {
    const mesh = new THREE.Mesh(geo, materials[key]);
    mesh.castShadow = true;
    chassis.add(mesh);
    disposables.push(geo);
  }

  // ======================= wheels =========================
  const tyreMat = new THREE.MeshStandardMaterial({ map: tyreTex, roughness: 0.95 });
  disposables.push(tyreMat);

  function buildWheel(radius: number, width: number): THREE.Group {
    const g = new THREE.Group();
    const tyreGeo = new THREE.CylinderGeometry(radius, radius, width, 22);
    const tyre = new THREE.Mesh(tyreGeo, tyreMat);
    tyre.rotation.z = Math.PI / 2;
    tyre.castShadow = true;
    g.add(tyre);

    // Three-spoke wheel. Bright rims against a black tyre are what make the
    // rotation visible - a uniformly dark wheel just looks like a blob.
    const hubGeo = new THREE.CylinderGeometry(radius * 0.26, radius * 0.26, width * 0.9, 12);
    const hub = new THREE.Mesh(hubGeo, materials.rim);
    hub.rotation.z = Math.PI / 2;
    g.add(hub);

    const spokeGeo = new THREE.BoxGeometry(width * 0.62, radius * 1.42, 0.058);
    for (let i = 0; i < 3; i++) {
      const spoke = new THREE.Mesh(spokeGeo, materials.rim);
      spoke.rotation.x = (i / 3) * Math.PI;
      g.add(spoke);
    }

    // Wheel rim lip: a bright ring right under the tyre bead.
    const lipGeo = new THREE.TorusGeometry(radius * 0.74, 0.022, 6, 20);
    for (const sx of [-1, 1]) {
      const lip = new THREE.Mesh(lipGeo, materials.rim);
      lip.rotation.y = Math.PI / 2;
      lip.position.x = sx * width * 0.34;
      g.add(lip);
    }

    // Brake disc, drilled - the holes give the eye something to track.
    const discGeo = new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, 0.014, 18);
    const disc = new THREE.Mesh(discGeo, materials.chrome);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = width * 0.62;
    g.add(disc);

    disposables.push(tyreGeo, hubGeo, spokeGeo, lipGeo, discGeo);
    return g;
  }

  const rearWheel = buildWheel(R_REAR, 0.17);
  rearWheel.position.set(0, R_REAR, 0.7);
  chassis.add(rearWheel);

  // ======================= steering + forks =========================
  const steering = new THREE.Group();
  // Pivot at the steering head so the front end turns about the right axis.
  steering.position.set(0, 0.92, -0.52);
  chassis.add(steering);

  const forkGroup = new THREE.Group();
  steering.add(forkGroup);

  const forkGeo = new THREE.CylinderGeometry(0.026, 0.03, 0.4, 8);
  const sliderGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.32, 8);
  for (const sx of [-1, 1]) {
    const fork = new THREE.Mesh(forkGeo, materials.chrome);
    fork.position.set(sx * 0.095, -0.16, -0.04);
    fork.rotation.x = FORK_ANGLE;
    forkGroup.add(fork);

    const slider = new THREE.Mesh(sliderGeo, materials.dark);
    slider.position.set(sx * 0.095, -0.44, -0.16);
    slider.rotation.x = FORK_ANGLE;
    forkGroup.add(slider);
  }
  const yokeGeo = new THREE.BoxGeometry(0.26, 0.04, 0.1);
  const yoke = new THREE.Mesh(yokeGeo, materials.rim);
  yoke.position.set(0, 0.02, 0.02);
  forkGroup.add(yoke);
  disposables.push(forkGeo, sliderGeo, yokeGeo);

  const frontWheel = buildWheel(R_FRONT, 0.13);
  forkGroup.add(frontWheel);

  // Front fender.
  const fenderGeo = new THREE.CylinderGeometry(R_FRONT + 0.06, R_FRONT + 0.06, 0.15, 14, 1, true, 0.6, 1.9);
  const fender = new THREE.Mesh(fenderGeo, materials.paint);
  fender.rotation.z = Math.PI / 2;
  forkGroup.add(fender);
  disposables.push(fenderGeo);

  /** Fork travel: the whole front end rises and the nose drops. */
  // Front axle in steering-head space: world (0, 0.31, -0.70).
  const forkRest = new THREE.Vector3(0, -0.61, -0.18);
  function setDive(amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    frontWheel.position.set(forkRest.x, forkRest.y + a * 0.075, forkRest.z - a * 0.03);
    fender.position.copy(frontWheel.position);
    fender.position.y += 0.02;
  }
  setDive(0);

  // ======================= lights =========================
  const headGeo = new THREE.SphereGeometry(0.12, 10, 8);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff4d6, emissive: 0xffe9b0, emissiveIntensity: 1.1, toneMapped: false,
  });
  const headMesh = new THREE.Mesh(headGeo, headMat);
  headMesh.position.set(0, 0.84, -0.8);
  headMesh.scale.set(1.3, 0.7, 0.6);
  chassis.add(headMesh);
  disposables.push(headGeo, headMat);

  const glowTex = makeGlowTexture({ color: '255,240,210' });
  const headlight = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTex, color: 0xffeccc, transparent: true, opacity: 0.7,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  headlight.scale.set(0.5, 0.5, 1);
  headlight.position.set(0, 0.84, -0.86);
  chassis.add(headlight);
  disposables.push(glowTex, headlight.material);

  const brakeLight = new THREE.MeshStandardMaterial({
    color: 0x5a0d0d, emissive: 0xff1a1a, emissiveIntensity: 0.3, toneMapped: false,
  });
  const brakeGeo = new THREE.BoxGeometry(0.18, 0.06, 0.04);
  const brake = new THREE.Mesh(brakeGeo, brakeLight);
  brake.position.set(0, 0.92, 0.86);
  chassis.add(brake);
  disposables.push(brakeGeo, brakeLight);

  // ======================= police light bar =========================
  let lightBar: THREE.Group | null = null;
  if (isCop) {
    lightBar = new THREE.Group();
    lightBar.position.set(0, 1.08, 0.72);
    const barGeo = new THREE.BoxGeometry(0.15, 0.09, 0.15);
    for (const [sx, hexColour] of [[-1, 0xff2020], [1, 0x2050ff]] as const) {
      const lampMat = new THREE.MeshStandardMaterial({
        color: hexColour, emissive: hexColour, emissiveIntensity: 1.5, toneMapped: false,
      });
      const lamp = new THREE.Mesh(barGeo, lampMat);
      lamp.position.x = sx * 0.1;
      lightBar.add(lamp);
      disposables.push(lampMat);
    }
    disposables.push(barGeo);
    chassis.add(lightBar);
  }

  // ======================= contact shadows =========================
  // A low sun throws the real shadow a long way from the bike, which reads as
  // hovering. A blob at each contact patch pins it to the road.
  const shadowTex = makeContactShadowTexture();
  const shadowMat = new THREE.MeshBasicMaterial({
    map: shadowTex, transparent: true, depthWrite: false, opacity: 0.85,
  });
  const shadowGeo = new THREE.PlaneGeometry(1, 1);
  const contactShadows: THREE.Mesh[] = [];
  for (const z of [-0.7, 0.7]) {
    const blob = new THREE.Mesh(shadowGeo, shadowMat);
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(0, 0.02, z);
    blob.scale.set(0.62, 1.15, 1);
    blob.renderOrder = 3;
    root.add(blob);
    contactShadows.push(blob);
  }
  disposables.push(shadowTex, shadowMat, shadowGeo);

  return {
    root,
    chassis,
    steering,
    contactShadows,
    frontWheel,
    rearWheel,
    setDive,
    brakeLight,
    headlight,
    lightBar,
    // Top of the seat pad, where the rider's pelvis sits.
    seatOffset: new THREE.Vector3(0, 0.83, 0.3),
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/** Kept for API compatibility; geometry is per-rig now, so nothing is shared. */
export function disposeBikeGeometry(): void {}

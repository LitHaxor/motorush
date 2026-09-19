// Bike + rider built from primitives. Authored facing -Z so that setting
// `root.rotation.y = heading` lines it up with the track's forward vector.

import * as THREE from 'three';
import { makeGlowTexture } from './textures';
import type { RacerKind } from '../sim/types';

export interface ArmRest {
  x: number;
  z: number;
}

export interface BikeRig {
  root: THREE.Group;
  /** Child that carries the lean so the wheels stay planted on the root. */
  lean: THREE.Group;
  frontWheel: THREE.Group;
  rearWheel: THREE.Group;
  rider: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  clubL: THREE.Mesh;
  clubR: THREE.Mesh;
  /** Rest pose of the arms, restored when not swinging. */
  armRest: ArmRest;
  headlight: THREE.Sprite;
  brakeLight: THREE.MeshStandardMaterial;
  lightBar: THREE.Group | null;
  dispose(): void;
}

// Geometry is identical for every bike, so build each shape once.
const geoCache = new Map<string, THREE.BufferGeometry>();
function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g as T;
}

const TYRE = 0x18181b;
const DARK = 0x24262c;

function makeWheel(tyreMat: THREE.Material, rimMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const tyre = new THREE.Mesh(
    geo('tyre', () => new THREE.CylinderGeometry(0.33, 0.33, 0.14, 18)),
    tyreMat,
  );
  tyre.rotation.z = Math.PI / 2;
  tyre.castShadow = true;
  g.add(tyre);

  const rim = new THREE.Mesh(
    geo('rim', () => new THREE.CylinderGeometry(0.19, 0.19, 0.16, 12)),
    rimMat,
  );
  rim.rotation.z = Math.PI / 2;
  g.add(rim);
  return g;
}

/** A limb: a group pivoting at the shoulder/hip with the limb hanging off it. */
function makeLimb(mat: THREE.Material, length: number, radius: number): THREE.Group {
  const pivot = new THREE.Group();
  const limb = new THREE.Mesh(
    geo(`limb-${length}-${radius}`, () => new THREE.CapsuleGeometry(radius, length, 3, 6)),
    mat,
  );
  limb.position.y = -length / 2;
  limb.castShadow = true;
  pivot.add(limb);
  return pivot;
}

export function createBikeRig(color: number, kind: RacerKind = 'rival'): BikeRig {
  const root = new THREE.Group();
  const lean = new THREE.Group();
  root.add(lean);

  const bodyColor = new THREE.Color(color);
  const materials: THREE.Material[] = [];
  const mat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };

  const paint = mat(new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.35, metalness: 0.55 }));
  const dark = mat(new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.6, metalness: 0.5 }));
  const tyreMat = mat(new THREE.MeshStandardMaterial({ color: TYRE, roughness: 0.95 }));
  const rimMat = mat(new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.3, metalness: 0.9 }));
  const chrome = mat(new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.18, metalness: 1 }));
  const leather = mat(new THREE.MeshStandardMaterial({
    color: kind === 'cop' ? 0x1a2237 : new THREE.Color(color).multiplyScalar(0.55),
    roughness: 0.75,
  }));
  const helmetMat = mat(new THREE.MeshStandardMaterial({
    color: kind === 'cop' ? 0xf0f2f5 : bodyColor,
    roughness: 0.25,
    metalness: 0.2,
  }));
  const visorMat = mat(new THREE.MeshStandardMaterial({
    color: 0x0c1118,
    roughness: 0.08,
    metalness: 0.9,
    emissive: 0x16202e,
    emissiveIntensity: 0.4,
  }));
  const brakeLight = mat(new THREE.MeshStandardMaterial({
    color: 0x5a0d0d,
    emissive: 0xff1a1a,
    emissiveIntensity: 0.25,
  }));

  // --- wheels ------------------------------------------------------------
  const front = makeWheel(tyreMat, rimMat);
  front.position.set(0, 0.33, -0.72);
  lean.add(front);
  const rear = makeWheel(tyreMat, rimMat);
  rear.position.set(0, 0.33, 0.68);
  lean.add(rear);

  // --- chassis -------------------------------------------------------------
  const engine = new THREE.Mesh(geo('engine', () => new THREE.BoxGeometry(0.34, 0.34, 0.62)), dark);
  engine.position.set(0, 0.46, 0.06);
  engine.castShadow = true;
  lean.add(engine);

  const tank = new THREE.Mesh(geo('tank', () => new THREE.CapsuleGeometry(0.19, 0.42, 4, 8)), paint);
  tank.rotation.x = Math.PI / 2;
  tank.position.set(0, 0.76, 0.1);
  tank.castShadow = true;
  lean.add(tank);

  const fairing = new THREE.Mesh(geo('fairing', () => new THREE.ConeGeometry(0.26, 0.7, 10)), paint);
  fairing.rotation.x = -Math.PI / 2;
  fairing.position.set(0, 0.72, -0.55);
  fairing.castShadow = true;
  lean.add(fairing);

  const seat = new THREE.Mesh(geo('seat', () => new THREE.BoxGeometry(0.3, 0.12, 0.5)), dark);
  seat.position.set(0, 0.86, 0.5);
  lean.add(seat);

  const tail = new THREE.Mesh(geo('tail', () => new THREE.BoxGeometry(0.26, 0.16, 0.22)), paint);
  tail.position.set(0, 0.92, 0.82);
  lean.add(tail);

  const brake = new THREE.Mesh(geo('brake', () => new THREE.BoxGeometry(0.2, 0.08, 0.04)), brakeLight);
  brake.position.set(0, 0.92, 0.94);
  lean.add(brake);

  const forks = new THREE.Mesh(geo('forks', () => new THREE.CylinderGeometry(0.045, 0.045, 0.72, 6)), chrome);
  forks.position.set(0, 0.62, -0.68);
  forks.rotation.x = 0.36;
  lean.add(forks);

  const bars = new THREE.Mesh(geo('bars', () => new THREE.CylinderGeometry(0.035, 0.035, 0.64, 6)), chrome);
  bars.rotation.z = Math.PI / 2;
  bars.position.set(0, 0.99, -0.5);
  lean.add(bars);

  for (const sign of [-1, 1]) {
    const pipe = new THREE.Mesh(geo('pipe', () => new THREE.CylinderGeometry(0.06, 0.08, 0.7, 8)), chrome);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(sign * 0.17, 0.42, 0.62);
    lean.add(pipe);
  }

  // --- rider ---------------------------------------------------------------
  const rider = new THREE.Group();
  rider.position.set(0, 0.86, 0.34);
  lean.add(rider);

  const torso = new THREE.Mesh(geo('torso', () => new THREE.CapsuleGeometry(0.17, 0.34, 4, 8)), leather);
  torso.position.set(0, 0.28, -0.08);
  torso.rotation.x = -0.52; // tucked over the tank
  torso.castShadow = true;
  rider.add(torso);

  const helmet = new THREE.Mesh(geo('helmet', () => new THREE.SphereGeometry(0.165, 14, 12)), helmetMat);
  helmet.position.set(0, 0.56, -0.28);
  helmet.castShadow = true;
  rider.add(helmet);

  const visor = new THREE.Mesh(geo('visor', () => new THREE.SphereGeometry(0.168, 12, 8, 0, Math.PI, 0.9, 0.9)), visorMat);
  visor.position.copy(helmet.position);
  visor.rotation.set(0.35, Math.PI, 0);
  rider.add(visor);

  const armL = makeLimb(leather, 0.34, 0.058);
  armL.position.set(-0.17, 0.4, -0.16);
  armL.rotation.set(-0.95, 0, 0.18);
  rider.add(armL);

  const armR = makeLimb(leather, 0.34, 0.058);
  armR.position.set(0.17, 0.4, -0.16);
  armR.rotation.set(-0.95, 0, -0.18);
  rider.add(armR);

  for (const sign of [-1, 1]) {
    const leg = makeLimb(leather, 0.36, 0.075);
    leg.position.set(sign * 0.14, 0.05, 0.06);
    leg.rotation.set(0.75, 0, sign * 0.1);
    rider.add(leg);
  }

  // Clubs live on the hands and are shown only while armed.
  const clubMat = mat(new THREE.MeshStandardMaterial({
    color: kind === 'cop' ? 0x11151c : 0x6b4a2a,
    roughness: 0.7,
  }));
  const makeClub = (): THREE.Mesh => {
    const club = new THREE.Mesh(
      geo('club', () => new THREE.CylinderGeometry(0.035, 0.05, 0.56, 6)),
      clubMat,
    );
    club.position.set(0, -0.42, -0.1);
    club.rotation.x = 1.2;
    club.visible = false;
    club.castShadow = true;
    return club;
  };
  const clubL = makeClub();
  const clubR = makeClub();
  armL.add(clubL);
  armR.add(clubR);

  // --- lights ---------------------------------------------------------------
  const glowTex = makeGlowTexture({ color: '255,240,210' });
  const headlight = new THREE.Sprite(
    mat(new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xffeccc,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })),
  );
  headlight.scale.set(0.5, 0.5, 1);
  headlight.position.set(0, 0.8, -0.86);
  lean.add(headlight);

  // --- police light bar -------------------------------------------------------
  let lightBar: THREE.Group | null = null;
  if (kind === 'cop') {
    lightBar = new THREE.Group();
    lightBar.position.set(0, 1.12, 0.78);
    const barGeo = geo('copbar', () => new THREE.BoxGeometry(0.16, 0.1, 0.16));
    for (const [sign, hex] of [[-1, 0xff2020], [1, 0x2050ff]] as const) {
      const lamp = new THREE.Mesh(
        barGeo,
        mat(new THREE.MeshStandardMaterial({
          color: hex,
          emissive: hex,
          emissiveIntensity: 1.5,
          toneMapped: false,
        })),
      );
      lamp.position.x = sign * 0.11;
      lightBar.add(lamp);
    }
    lean.add(lightBar);
  }

  return {
    root,
    lean,
    frontWheel: front,
    rearWheel: rear,
    rider,
    armL,
    armR,
    clubL,
    clubR,
    armRest: { x: -0.95, z: 0.18 },
    headlight,
    brakeLight,
    lightBar,
    dispose() {
      for (const m of materials) m.dispose();
      glowTex.dispose();
    },
  };
}

/** Drop the shared geometry cache (used when tearing the game down for good). */
export function disposeBikeGeometry(): void {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
}

// The rider: an articulated figure driven entirely by a joint skeleton.
//
// Both modes write the same 16 joint positions and the mesh is rebuilt from
// them every frame:
//   - riding  -> forward kinematics from a pose (tuck, lean, punch)
//   - crashed -> a Verlet ragdoll solved against the road
//
// One render path for both is what makes the transition between them seamless.

import * as THREE from 'three';
import { makeLeatherTexture, makeHelmetTexture } from './textures';
import { clamp } from '../sim/mathx';

export const JOINTS = [
  'pelvis', 'chest', 'neck', 'head',
  'shoulderL', 'elbowL', 'handL',
  'shoulderR', 'elbowR', 'handR',
  'hipL', 'kneeL', 'footL',
  'hipR', 'kneeR', 'footR',
] as const;

export type JointName = (typeof JOINTS)[number];

export const J: Record<JointName, number> = JOINTS.reduce(
  (acc, name, i) => {
    acc[name] = i;
    return acc;
  },
  {} as Record<JointName, number>,
);

export type Skeleton = THREE.Vector3[];

export const makeSkeleton = (): Skeleton => JOINTS.map(() => new THREE.Vector3());

/** Rest lengths between connected joints, in metres. Also the ragdoll bones. */
export const BONES: [JointName, JointName][] = [
  ['pelvis', 'chest'],
  ['chest', 'neck'],
  ['neck', 'head'],
  ['chest', 'shoulderL'], ['shoulderL', 'elbowL'], ['elbowL', 'handL'],
  ['chest', 'shoulderR'], ['shoulderR', 'elbowR'], ['elbowR', 'handR'],
  ['pelvis', 'hipL'], ['hipL', 'kneeL'], ['kneeL', 'footL'],
  ['pelvis', 'hipR'], ['hipR', 'kneeR'], ['kneeR', 'footR'],
];

/** Extra links that stop the torso and hips folding in on themselves. */
export const BRACES: [JointName, JointName][] = [
  ['pelvis', 'neck'],
  ['shoulderL', 'shoulderR'],
  ['hipL', 'hipR'],
  ['shoulderL', 'pelvis'],
  ['shoulderR', 'pelvis'],
  ['hipL', 'chest'],
  ['hipR', 'chest'],
];

/**
 * The tucked racing crouch, in local space with the pelvis on the seat,
 * +Y up and -Z forward. Everything else is a deformation of this.
 */
const REST: Record<JointName, [number, number, number]> = {
  pelvis: [0, 0, 0],
  // A proper racing crouch: the back is about 40 degrees off horizontal and
  // the head ends up over the tank, behind the screen - not sitting bolt
  // upright over the back wheel.
  chest: [0, 0.27, -0.33],
  neck: [0, 0.36, -0.46],
  head: [0, 0.41, -0.56],
  shoulderL: [-0.19, 0.32, -0.41],
  elbowL: [-0.25, 0.21, -0.56],
  // Hands land on the clip-ons.
  handL: [-0.26, 0.13, -0.74],
  shoulderR: [0.19, 0.32, -0.41],
  elbowR: [0.25, 0.21, -0.56],
  handR: [0.26, 0.13, -0.74],
  hipL: [-0.13, -0.04, 0.02],
  // Knees forward, gripping the tank.
  kneeL: [-0.23, -0.28, -0.28],
  // Feet on the pegs.
  footL: [-0.21, -0.48, -0.14],
  hipR: [0.13, -0.04, 0.02],
  kneeR: [0.23, -0.28, -0.28],
  footR: [0.21, -0.48, -0.14],
};

export function restSkeleton(out: Skeleton = makeSkeleton()): Skeleton {
  for (const name of JOINTS) out[J[name]].set(...REST[name]);
  return out;
}

/** Rest bone lengths, measured once from the rest pose. */
export const BONE_LENGTHS: number[] = (() => {
  const rest = restSkeleton();
  return BONES.map(([a, b]) => rest[J[a]].distanceTo(rest[J[b]]));
})();

export const BRACE_LENGTHS: number[] = (() => {
  const rest = restSkeleton();
  return BRACES.map(([a, b]) => rest[J[a]].distanceTo(rest[J[b]]));
})();

export interface RidingPose {
  /** 0 sitting upright, 1 flat on the tank. */
  tuck: number;
  /** -1..1, weight shifted off the inside of the bike. */
  lean: number;
  /** 0..1 sitting up and squaring off under the brakes. */
  brake: number;
  /** -1 left, 0 none, +1 right. */
  swingDir: number;
  /** 0..1 through the swing. */
  swing: number;
}

const V = new THREE.Vector3();

/** Write the riding pose into `out`. */
export function poseRiding(out: Skeleton, p: RidingPose): Skeleton {
  restSkeleton(out);

  // --- tuck: fold down over the tank ------------------------------------
  // Positive tuck flattens the back further; braking pulls them upright.
  const tuck = clamp(p.tuck - p.brake * 1.3, -0.75, 1);
  for (const name of ['chest', 'neck', 'head', 'shoulderL', 'shoulderR'] as JointName[]) {
    const v = out[J[name]];
    v.y -= tuck * 0.07;
    v.z -= tuck * 0.08;
  }
  out[J.head].y -= tuck * 0.03;
  // Elbows tuck in as the rider gets down behind the screen.
  out[J.elbowL].x += tuck * 0.06;
  out[J.elbowR].x -= tuck * 0.06;

  // --- weight shift: hang off the inside ---------------------------------
  const shift = p.lean;
  out[J.pelvis].x += shift * 0.1;
  out[J.chest].x += shift * 0.06;
  out[J.head].x += shift * 0.04;
  out[J.hipL].x += shift * 0.1;
  out[J.hipR].x += shift * 0.1;
  // Inside knee comes out, outside knee grips the tank.
  const inside = shift >= 0 ? J.kneeR : J.kneeL;
  out[inside].x += shift * 0.14;
  out[inside].z -= Math.abs(shift) * 0.05;

  // --- swinging a fist or a club -----------------------------------------
  if (p.swing > 0 && p.swingDir !== 0) {
    const OUT = 0.42;
    const phase = p.swing < OUT ? p.swing / OUT : 1 - (p.swing - OUT) / (1 - OUT);
    const reach = Math.sin(clamp(phase, 0, 1) * Math.PI * 0.5);
    const dir = p.swingDir;
    const shoulder = dir > 0 ? J.shoulderR : J.shoulderL;
    const elbow = dir > 0 ? J.elbowR : J.elbowL;
    const hand = dir > 0 ? J.handR : J.handL;

    // Throw the arm out sideways and slightly forward, and twist the torso
    // after it so the whole body commits to the swing.
    out[elbow].set(dir * (0.3 + reach * 0.34), 0.3 + reach * 0.05, -0.3 + reach * 0.16);
    out[hand].set(dir * (0.36 + reach * 0.74), 0.26 + reach * 0.12, -0.34 + reach * 0.28);
    out[shoulder].x += dir * reach * 0.08;
    out[J.chest].x += dir * reach * 0.09;
    out[J.head].x += dir * reach * 0.06;
    out[J.head].z += reach * 0.03;
  }
  return out;
}

// ============================== the mesh ==============================

interface SegmentSpec {
  from: JointName;
  to: JointName;
  /** Capsule radius. Rounded ends overlap into the next limb, so the body
   *  reads as one continuous surface instead of a stack of parts. */
  r: number;
  /** Cross-section scaling: a torso is wide and shallow, not round. */
  sx?: number;
  sz?: number;
  material: 'leather' | 'boot' | 'glove';
}

const SEGMENTS: SegmentSpec[] = [
  // Torso: shoulder-wide, shallow front-to-back, tapering to the waist.
  { from: 'pelvis', to: 'chest', r: 0.125, sx: 1.42, sz: 0.72, material: 'leather' },
  { from: 'chest', to: 'neck', r: 0.078, sx: 1.25, sz: 0.9, material: 'leather' },
  // Shoulders filled by a capsule spanning the yoke.
  { from: 'shoulderL', to: 'shoulderR', r: 0.088, sx: 1, sz: 0.82, material: 'leather' },
  { from: 'shoulderL', to: 'elbowL', r: 0.052, material: 'leather' },
  { from: 'elbowL', to: 'handL', r: 0.043, material: 'leather' },
  { from: 'shoulderR', to: 'elbowR', r: 0.052, material: 'leather' },
  { from: 'elbowR', to: 'handR', r: 0.043, material: 'leather' },
  // Hips joined so the pelvis reads as one mass.
  { from: 'hipL', to: 'hipR', r: 0.09, sz: 0.88, material: 'leather' },
  { from: 'hipL', to: 'kneeL', r: 0.076, material: 'leather' },
  { from: 'kneeL', to: 'footL', r: 0.057, material: 'boot' },
  { from: 'hipR', to: 'kneeR', r: 0.076, material: 'leather' },
  { from: 'kneeR', to: 'footR', r: 0.057, material: 'boot' },
];

/** Rest length of each segment, used to size its capsule once. */
const SEGMENT_REST: number[] = (() => {
  const rest = restSkeleton();
  return SEGMENTS.map((s) => Math.max(0.05, rest[J[s.from]].distanceTo(rest[J[s.to]])));
})();

export interface RiderRig {
  root: THREE.Group;
  /** Live joint positions; write these then call `apply()`. */
  skeleton: Skeleton;
  apply(): void;
  setClubVisible(visible: boolean, dir: number): void;
  dispose(): void;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();
const tmpMid = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

export function createRiderRig(colour: number, accent = 0xf0f0ea, kind = 'rival'): RiderRig {
  const root = new THREE.Group();
  root.name = 'rider';

  const leatherTex = makeLeatherTexture(
    kind === 'cop' ? 0x1b2436 : colour,
    kind === 'cop' ? 0xdfe4ea : accent,
  );
  const helmetTex = makeHelmetTexture(
    kind === 'cop' ? 0xf2f4f7 : colour,
    kind === 'cop' ? 0x1b2436 : accent,
  );

  const leather = new THREE.MeshStandardMaterial({
    map: leatherTex, roughness: 0.38, metalness: 0.05, envMapIntensity: 0.9,
  });
  const boot = new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.55 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x1b1e25, roughness: 0.6 });
  const helmetMat = new THREE.MeshStandardMaterial({
    map: helmetTex, roughness: 0.16, metalness: 0.25,
  });
  const materials: Record<SegmentSpec['material'], THREE.Material> = { leather, boot, glove };

  const skeleton = restSkeleton();
  const meshes: THREE.Mesh[] = [];
  const geometries: THREE.BufferGeometry[] = [];

  // Limb segments are capsules sized to their rest length. Because the rounded
  // ends push into the neighbouring limb, the joints close themselves up and
  // the figure reads as one body rather than a bolted-together dummy.
  SEGMENTS.forEach((spec, i) => {
    const straight = Math.max(0.02, SEGMENT_REST[i] - spec.r * 2);
    const geo = new THREE.CapsuleGeometry(spec.r, straight, 6, 14);
    const mesh = new THREE.Mesh(geo, materials[spec.material]);
    mesh.castShadow = true;
    root.add(mesh);
    meshes.push(mesh);
    geometries.push(geo);
  });

  // Hands and feet, which do need their own shapes.
  const extremities: { joint: JointName; mesh: THREE.Mesh }[] = [];
  const gloveGeo = new THREE.SphereGeometry(0.047, 10, 8);
  for (const joint of ['handL', 'handR'] as JointName[]) {
    const mesh = new THREE.Mesh(gloveGeo, glove);
    mesh.scale.set(1, 1.15, 0.85);
    mesh.castShadow = true;
    root.add(mesh);
    extremities.push({ joint, mesh });
  }
  geometries.push(gloveGeo);

  // Helmet + visor.
  const helmetGeo = new THREE.SphereGeometry(0.122, 18, 14);
  const helmet = new THREE.Mesh(helmetGeo, helmetMat);
  helmet.castShadow = true;
  root.add(helmet);
  geometries.push(helmetGeo);

  // Shoulder armour humps, which do a lot for the silhouette.
  const humpGeo = new THREE.SphereGeometry(0.05, 8, 6);
  const humps: { joint: JointName; mesh: THREE.Mesh }[] = [];
  for (const joint of ['shoulderL', 'shoulderR'] as JointName[]) {
    const mesh = new THREE.Mesh(humpGeo, leather);
    // Armour pad: wide, flat, hugging the shoulder.
    mesh.scale.set(1.15, 0.7, 1.0);
    mesh.castShadow = true;
    root.add(mesh);
    humps.push({ joint, mesh });
  }
  geometries.push(humpGeo);

  // Boots: a blocky toe so the feet read as boots on the pegs.
  const bootGeo = new THREE.BoxGeometry(0.085, 0.065, 0.18);
  const boots: { joint: JointName; mesh: THREE.Mesh }[] = [];
  for (const joint of ['footL', 'footR'] as JointName[]) {
    const mesh = new THREE.Mesh(bootGeo, boot);
    mesh.castShadow = true;
    root.add(mesh);
    boots.push({ joint, mesh });
  }
  geometries.push(bootGeo);

  // Club, carried in whichever hand is swinging.
  const clubGeo = new THREE.CylinderGeometry(0.032, 0.05, 0.6, 7);
  const clubMat = new THREE.MeshStandardMaterial({
    color: kind === 'cop' ? 0x12161d : 0x6b4a2a,
    roughness: 0.7,
  });
  const club = new THREE.Mesh(clubGeo, clubMat);
  club.castShadow = true;
  club.visible = false;
  root.add(club);
  geometries.push(clubGeo);
  let clubDir = 1;

  function apply(): void {
    // Segments: point each cylinder from one joint to the next.
    SEGMENTS.forEach((spec, i) => {
      const a = skeleton[J[spec.from]];
      const b = skeleton[J[spec.to]];
      const mesh = meshes[i];
      tmpDir.subVectors(b, a);
      const len = tmpDir.length() || 0.0001;
      tmpMid.addVectors(a, b).multiplyScalar(0.5);
      mesh.position.copy(tmpMid);
      tmpQuat.setFromUnitVectors(UP, tmpDir.divideScalar(len));
      mesh.quaternion.copy(tmpQuat);
      // Scale only along the bone, relative to the length it was built at.
      mesh.scale.set(spec.sx ?? 1, len / SEGMENT_REST[i], spec.sz ?? 1);
    });

    for (const e of extremities) e.mesh.position.copy(skeleton[J[e.joint]]);

    // Head sits just past the neck, along the neck->head direction.
    const neck = skeleton[J.neck];
    const head = skeleton[J.head];
    helmet.position.copy(head);
    tmpDir.subVectors(head, neck).normalize();
    tmpQuat.setFromUnitVectors(UP, tmpDir);
    helmet.quaternion.copy(tmpQuat);

    for (const hump of humps) {
      hump.mesh.position.copy(skeleton[J[hump.joint]]);
      hump.mesh.position.y += 0.025;
      hump.mesh.quaternion.copy(helmet.quaternion);
    }

    // Boots point along the shin, toes forward.
    for (const b of boots) {
      const foot = skeleton[J[b.joint]];
      const knee = skeleton[J[b.joint === 'footL' ? 'kneeL' : 'kneeR']];
      b.mesh.position.copy(foot);
      tmpDir.subVectors(foot, knee).normalize();
      tmpQuat.setFromUnitVectors(UP, tmpDir);
      b.mesh.quaternion.copy(tmpQuat);
      b.mesh.translateZ(0.05);
    }

    if (club.visible) {
      const hand = skeleton[J[clubDir > 0 ? 'handR' : 'handL']];
      const elbow = skeleton[J[clubDir > 0 ? 'elbowR' : 'elbowL']];
      club.position.copy(hand);
      tmpDir.subVectors(hand, elbow).normalize();
      tmpQuat.setFromUnitVectors(UP, tmpDir);
      club.quaternion.copy(tmpQuat);
      club.translateY(0.24);
    }
  }

  apply();

  return {
    root,
    skeleton,
    apply,
    setClubVisible(visible, dir) {
      club.visible = visible;
      clubDir = dir >= 0 ? 1 : -1;
    },
    dispose() {
      for (const g of geometries) g.dispose();
      leather.dispose();
      boot.dispose();
      glove.dispose();
      helmetMat.dispose();
      clubMat.dispose();
      leatherTex.dispose();
      helmetTex.dispose();
    },
  };
}

/**
 * Getting up and running back to the bike. Positions are heights above the
 * road, so the rig root sits on the ground rather than at the hips.
 * `t` blends from a crouch (just picked themselves up) to fully upright.
 */
export function poseRunning(out: Skeleton, phase: number, t = 1): Skeleton {
  const swing = Math.sin(phase);
  const up = clamp(t, 0, 1);
  const bob = Math.abs(Math.cos(phase)) * 0.035 * up;

  // Crouched -> standing, for each joint: [crouchY, standY].
  const lift = (crouch: number, stand: number) => crouch + (stand - crouch) * up + bob;

  const set = (name: JointName, x: number, y: number, z: number) => {
    out[J[name]].set(x * (0.7 + 0.3 * up), y, z * up);
  };

  set('pelvis', 0, lift(0.52, 0.95), 0);
  set('chest', 0, lift(0.78, 1.32), -0.04);
  set('neck', 0, lift(0.92, 1.46), -0.06);
  set('head', 0, lift(1.0, 1.6), -0.07);

  set('shoulderL', -0.2, lift(0.9, 1.42), -0.03);
  set('shoulderR', 0.2, lift(0.9, 1.42), -0.03);
  // Arms pump opposite the legs.
  set('elbowL', -0.26, lift(0.68, 1.14), -0.08 - swing * 0.16);
  set('handL', -0.26, lift(0.5, 0.9), -0.1 - swing * 0.3);
  set('elbowR', 0.26, lift(0.68, 1.14), -0.08 + swing * 0.16);
  set('handR', 0.26, lift(0.5, 0.9), -0.1 + swing * 0.3);

  set('hipL', -0.13, lift(0.5, 0.92), 0);
  set('hipR', 0.13, lift(0.5, 0.92), 0);
  set('kneeL', -0.14, lift(0.26, 0.48) + Math.max(0, swing) * 0.14 * up, -swing * 0.24 * up);
  set('footL', -0.14, lift(0.08, 0.1) + Math.max(0, swing) * 0.18 * up, -swing * 0.4 * up);
  set('kneeR', 0.14, lift(0.26, 0.48) + Math.max(0, -swing) * 0.14 * up, swing * 0.24 * up);
  set('footR', 0.14, lift(0.08, 0.1) + Math.max(0, -swing) * 0.18 * up, swing * 0.4 * up);

  return out;
}

// Verlet ragdoll for a thrown rider.
//
// Sixteen point masses (one per joint) integrated with Verlet, wired together
// by distance constraints, bounced and scraped along the road. Tumbling is not
// animated - it falls out of the launch spin plus ground friction, which is
// why no two get-offs look the same.

import * as THREE from 'three';
import {
  J, JOINTS, BONES, BRACES, BONE_LENGTHS, BRACE_LENGTHS,
  type Skeleton, makeSkeleton,
} from './rider';

const GRAVITY = -19.5;
/** Velocity retained per second in the air. */
const AIR_DRAG = 0.06;
/** How much sideways speed survives a scrape along the tarmac. */
const GROUND_FRICTION = 0.72;
const RESTITUTION = 0.26;
const ITERATIONS = 7;

/** Joints that should not sink into the road, with their body radius. */
const RADII: Partial<Record<string, number>> = {
  head: 0.15, chest: 0.17, pelvis: 0.16,
  shoulderL: 0.1, shoulderR: 0.1,
  elbowL: 0.07, elbowR: 0.07,
  handL: 0.06, handR: 0.06,
  hipL: 0.12, hipR: 0.12,
  kneeL: 0.09, kneeR: 0.09,
  footL: 0.08, footR: 0.08,
  neck: 0.09,
};

export class Ragdoll {
  readonly positions: THREE.Vector3[] = JOINTS.map(() => new THREE.Vector3());
  private readonly previous: THREE.Vector3[] = JOINTS.map(() => new THREE.Vector3());
  private readonly radii: number[] = JOINTS.map((n) => RADII[n] ?? 0.1);
  private readonly tmp = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  active = false;
  /** Falls toward 0 as the body comes to rest. */
  energy = 0;

  /**
   * Throw the rider. `skeleton` is their pose in world space at the moment of
   * the crash, `velocity` the bike's velocity, `spin` an angular kick.
   */
  launch(skeleton: Skeleton, velocity: THREE.Vector3, spin: THREE.Vector3, dt = 1 / 60): void {
    const centre = this.tmp.set(0, 0, 0);
    for (const p of skeleton) centre.add(p);
    centre.divideScalar(skeleton.length);

    for (let i = 0; i < JOINTS.length; i++) {
      this.positions[i].copy(skeleton[i]);
      // Verlet stores velocity implicitly as (pos - prev), so seeding `prev`
      // is how the body inherits the bike's motion plus a tumble.
      this.tmpB.subVectors(skeleton[i], centre).cross(spin);
      this.tmpB.add(velocity);
      this.previous[i].copy(skeleton[i]).addScaledVector(this.tmpB, -dt);
    }
    this.active = true;
    this.energy = 1;
  }

  /** Advance the body. `groundY` is the road surface under the crash. */
  step(dt: number, groundY: number): void {
    if (!this.active) return;
    const drag = Math.max(0, 1 - AIR_DRAG * dt);
    const gdt = GRAVITY * dt * dt;

    // --- integrate ---------------------------------------------------
    for (let i = 0; i < JOINTS.length; i++) {
      const pos = this.positions[i];
      const prev = this.previous[i];
      this.tmp.subVectors(pos, prev).multiplyScalar(drag);
      prev.copy(pos);
      pos.add(this.tmp);
      pos.y += gdt;
    }

    // --- constraints --------------------------------------------------
    for (let iter = 0; iter < ITERATIONS; iter++) {
      this.solve(BONES, BONE_LENGTHS, 1);
      // Braces are softer so the torso can still deform a little on impact.
      this.solve(BRACES, BRACE_LENGTHS, 0.55);
      this.collideGround(groundY);
    }

    // --- settle metric -------------------------------------------------
    let moving = 0;
    for (let i = 0; i < JOINTS.length; i++) {
      moving += this.positions[i].distanceToSquared(this.previous[i]);
    }
    this.energy = Math.sqrt(moving / JOINTS.length) / Math.max(dt, 1e-4);
  }

  private solve(
    links: readonly [string, string][],
    lengths: readonly number[],
    stiffness: number,
  ): void {
    for (let i = 0; i < links.length; i++) {
      const a = this.positions[J[links[i][0] as keyof typeof J]];
      const b = this.positions[J[links[i][1] as keyof typeof J]];
      this.tmp.subVectors(b, a);
      const dist = this.tmp.length();
      if (dist < 1e-6) continue;
      const diff = ((dist - lengths[i]) / dist) * 0.5 * stiffness;
      this.tmp.multiplyScalar(diff);
      a.add(this.tmp);
      b.sub(this.tmp);
    }
  }

  private collideGround(groundY: number): void {
    for (let i = 0; i < JOINTS.length; i++) {
      const pos = this.positions[i];
      const floor = groundY + this.radii[i];
      if (pos.y >= floor) continue;

      const prev = this.previous[i];
      const vy = pos.y - prev.y;
      pos.y = floor;
      // Bounce a little, and scrub horizontal speed against the tarmac.
      prev.y = pos.y + vy * RESTITUTION;
      prev.x = pos.x - (pos.x - prev.x) * GROUND_FRICTION;
      prev.z = pos.z - (pos.z - prev.z) * GROUND_FRICTION;
    }
  }

  /** True once the body has essentially stopped moving. */
  get settled(): boolean {
    return this.active && this.energy < 0.35;
  }

  /** Copy the solved positions into a skeleton for rendering. */
  writeInto(out: Skeleton): void {
    for (let i = 0; i < JOINTS.length; i++) out[i].copy(this.positions[i]);
  }

  /** Where the body ended up, for the run-back animation to start from. */
  centre(out = new THREE.Vector3()): THREE.Vector3 {
    out.set(0, 0, 0);
    for (const p of this.positions) out.add(p);
    return out.divideScalar(this.positions.length);
  }

  stop(): void {
    this.active = false;
    this.energy = 0;
  }
}

/** Scratch skeleton used when launching from a local-space pose. */
export const scratchSkeleton = makeSkeleton();

// ============================ the bike ============================

const BIKE_GRAVITY = -21;
const BIKE_RESTITUTION = 0.34;
const BIKE_FRICTION = 0.82;
/** How high the bike's centre sits when it is lying on its side. */
const BIKE_REST_HEIGHT = 0.3;

/**
 * Rigid-body tumble for a crashed bike.
 *
 * Works in the bike's own track-local frame (x sideways, y up, z along the
 * road) so the simulation stays in charge of how far it slides, while this
 * owns the part nobody needs to agree on: how it cartwheels getting there.
 */
export class BikeTumble {
  readonly offset = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  private readonly velocity = new THREE.Vector3();
  private readonly angular = new THREE.Vector3();
  private readonly spinQuat = new THREE.Quaternion();
  private readonly restQuat = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();

  active = false;
  /** Which way it ends up lying. */
  private side = 1;

  launch(severity: number, speed: number, rng: () => number = Math.random): void {
    const sev = Math.max(0.15, Math.min(1, severity));
    this.offset.set(0, 0, 0);
    this.quaternion.identity();

    // Mostly upward and sideways: the simulation already slides it forward.
    this.velocity.set(
      (rng() - 0.5) * 7 * sev,
      2.2 + sev * 4.6 + Math.min(speed, 70) * 0.03,
      (rng() - 0.5) * 3 + sev * 2,
    );
    // A proper tumble needs rotation on more than one axis.
    this.angular.set(
      (rng() - 0.5) * 9 * sev,
      (rng() - 0.5) * 5 * sev,
      (rng() < 0.5 ? -1 : 1) * (5 + sev * 11),
    );
    this.side = this.angular.z >= 0 ? 1 : -1;
    // Resting attitude: on its side, wheels pointing across the road.
    this.restQuat.setFromEuler(new THREE.Euler(0, 0, this.side * Math.PI * 0.5));
    this.active = true;
  }

  step(dt: number): void {
    if (!this.active) return;

    this.velocity.y += BIKE_GRAVITY * dt;
    this.offset.addScaledVector(this.velocity, dt);

    // Integrate the orientation from the angular velocity.
    const speed = this.angular.length();
    if (speed > 1e-4) {
      this.axis.copy(this.angular).divideScalar(speed);
      this.spinQuat.setFromAxisAngle(this.axis, speed * dt);
      this.quaternion.premultiply(this.spinQuat).normalize();
    }

    if (this.offset.y <= BIKE_REST_HEIGHT) {
      this.offset.y = BIKE_REST_HEIGHT;
      if (this.velocity.y < 0) {
        // Bounce, scrub speed, and knock the spin down hard on each impact.
        this.velocity.y = -this.velocity.y * BIKE_RESTITUTION;
        if (this.velocity.y < 1.2) this.velocity.y = 0;
        this.velocity.x *= BIKE_FRICTION;
        this.velocity.z *= BIKE_FRICTION;
        this.angular.multiplyScalar(0.45);
      }
      // Grinding along the tarmac bleeds the rest off.
      this.velocity.x *= Math.max(0, 1 - 2.4 * dt);
      this.velocity.z *= Math.max(0, 1 - 2.4 * dt);
      this.angular.multiplyScalar(Math.max(0, 1 - 3.5 * dt));

      // Once it has stopped rolling, let it settle onto its side.
      if (this.angular.length() < 2.2) {
        this.quaternion.slerp(this.restQuat, Math.min(1, dt * 4));
        this.angular.multiplyScalar(Math.max(0, 1 - 8 * dt));
      }
    } else {
      // Air drag, so a big launch does not fly forever.
      this.velocity.multiplyScalar(Math.max(0, 1 - 0.25 * dt));
    }
  }

  get settled(): boolean {
    return this.active && this.angular.length() < 0.4 && Math.abs(this.velocity.y) < 0.2;
  }

  stop(): void {
    this.active = false;
    this.offset.set(0, 0, 0);
    this.quaternion.identity();
    this.velocity.set(0, 0, 0);
    this.angular.set(0, 0, 0);
  }
}

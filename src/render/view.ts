// The renderer. Owns the Three.js scene and mirrors simulation state into it
// every frame. The sim never knows this file exists.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import type { World } from '../sim/world';
import type { Car, Racer, RacerInput, SimEvent } from '../sim/types';
import { clamp, damp, makeRng } from '../sim/mathx';
import { BIKE, COMBAT } from '../sim/config';
import { swingProgress } from '../sim/combat';

import { pickSky, type SkyPreset } from './palette';
import { createSky, type SkyHandle } from './sky';
import {
  buildRoad, buildWater, buildPaddies, buildPavements,
  buildFinishLine, buildStartLine, type RoadHandle,
} from './roadmesh';
import {
  buildScenery, createPickupMesh, createPedestrianMesh, buildCrossings,
  type SceneryHandle, type PickupRig, type PedestrianRig,
} from './scenery';
import { createBikeRig, disposeBikeGeometry, type BikeRig } from './bikemesh';
import { createRiderRig, poseRiding, poseRunning, type RiderRig } from './rider';
import { Ragdoll, BikeTumble, scratchSkeleton } from './ragdoll';
import { createCarMesh, createCarFromModel, disposeCarGeometry, type CarRig } from './carmesh';
import { ParticleField, CameraShake } from './effects';
import { loadGroundTextures, type GroundTextures } from './assets';
import { loadModels, CAR_MODELS, type ModelLibrary } from './models';
import { loadFoliageAtlas, buildTreeVariants, buildGrassTuft, type TreeVariant } from './foliage';

export type QualityLevel = 'low' | 'high';

/** Per-racer crash animation state. */
interface CrashFx {
  /** Rigid-body tumble for the bike itself. */
  tumble: BikeTumble;
  /** Doubles as fork-dive smoothing while upright, stand-up blend while down. */
  standT: number;
  runPhase: number;
}

export interface GameViewOptions {
  quality?: QualityLevel | 'auto';
}

const UPRIGHT = new THREE.Quaternion();

const CAM = {
  // Tight over-the-shoulder framing: the bike should fill the lower third of
  // the screen, as it does in the games this is modelled on.
  back: 4.4,
  backSpeedGain: 1.5,
  height: 1.95,
  lookAhead: 15,
  lookHeight: 1.15,
  baseFov: 62,
  speedFov: 14,
  boostFov: 5,
};

export class GameView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private readonly canvas: HTMLCanvasElement;

  private world: World;
  private preset: SkyPreset;
  private sky!: SkyHandle;
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;

  private road: RoadHandle | null = null;
  private scenery: SceneryHandle | null = null;
  private trackProps: THREE.Group | null = null;
  private water: { group: THREE.Group; dispose(): void } | null = null;
  private paddies: { group: THREE.Group; dispose(): void } | null = null;
  private pavements: { group: THREE.Group; dispose(): void } | null = null;

  private readonly bikeRigs = new Map<number, BikeRig>();
  private readonly riderRigs = new Map<number, RiderRig>();
  private readonly ragdolls = new Map<number, Ragdoll>();
  private readonly crashFx = new Map<number, CrashFx>();
  /** Last brake input, used for fork dive and the brake light. */
  private playerBrake = 0;
  private readonly carRigs = new Map<number, CarRig>();
  private readonly carPool = new Map<string, CarRig[]>();
  private readonly pickupRigs = new Map<number, PickupRig>();
  private readonly pedRigs = new Map<number, PedestrianRig>();
  private crossingsGroup: { group: THREE.Group; dispose(): void } | null = null;
  private readonly downAnim = new Map<number, number>();

  private readonly particles = new ParticleField();
  private readonly shake = new CameraShake();

  private camLateral = 0;
  private time = 0;
  private quality: QualityLevel = 'high';
  private autoQuality: boolean;
  private frameEma = 16;
  private slowFrames = 0;

  private textures!: GroundTextures;
  private models!: ModelLibrary;
  private treeVariants: TreeVariant[] = [];
  private grassTuft: TreeVariant | null = null;

  // Scratch objects reused every frame to keep the GC quiet.
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly tmpSample = { x: 0, y: 0, z: 0, heading: 0, curvature: 0 };

  private constructor(canvas: HTMLCanvasElement, world: World, opts: GameViewOptions) {
    this.canvas = canvas;
    this.world = world;
    this.preset = pickSky(world.seed);
    this.autoQuality = (opts.quality ?? 'auto') === 'auto';
    if (opts.quality === 'low' || opts.quality === 'high') this.quality = opts.quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.preset.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(CAM.baseFov, 16 / 9, 0.3, 5000);
    this.scene.add(this.camera);
  }

  static async create(
    canvas: HTMLCanvasElement,
    world: World,
    opts: GameViewOptions = {},
  ): Promise<GameView> {
    const view = new GameView(canvas, world, opts);
    const preset = view.preset;
    // Ground textures and props load in parallel; both fall back gracefully.
    const [textures, models, foliage] = await Promise.all([
      loadGroundTextures(view.renderer, { grass: preset.grass, grassAccent: preset.grassAccent }),
      loadModels(),
      loadFoliageAtlas(),
    ]);
    view.textures = textures;
    view.models = models;
    const foliageRng = makeRng(world.seed ^ 0x5eed);
    view.treeVariants = buildTreeVariants(foliage, foliageRng);
    view.grassTuft = buildGrassTuft(foliage, foliageRng);
    view.setupScene();
    view.buildWorld();
    (window as unknown as { __rbView?: GameView }).__rbView = view;
    view.applyQuality();
    view.resize();
    return view;
  }

  // ------------------------------------------------------------------ setup
  private setupScene(): void {
    const p = this.preset;
    this.scene.fog = new THREE.FogExp2(p.fog, p.fogDensity);

    this.sky = createSky(p);
    this.scene.add(this.sky.mesh);

    this.hemi = new THREE.HemisphereLight(p.ambient, p.hemiGround, p.ambientIntensity);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(p.sun, p.sunIntensity);
    this.sun.castShadow = true;
    // A tight shadow frustum that rides along with the player keeps the shadow
    // map detailed where it actually matters.
    const d = 46;
    this.sun.shadow.camera.left = -d;
    this.sun.shadow.camera.right = d;
    this.sun.shadow.camera.top = d;
    this.sun.shadow.camera.bottom = -d;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 220;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.scene.add(this.particles.points);

    // Reflections come from the sky itself, so they match the time of day.
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envScene = new THREE.Scene();
      const skyClone = this.sky.mesh.clone();
      (skyClone.material as THREE.Material).depthTest = true;
      envScene.add(skyClone);
      this.scene.environment = pmrem.fromScene(envScene, 0, 0.1, 1000).texture;
      this.scene.environmentIntensity = 0.65;
      pmrem.dispose();
    } catch (err) {
      console.warn('[roadbrush] environment map unavailable', err);
    }

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.52, 0.5, 0.86);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  /** Build everything that depends on the current track. */
  private buildWorld(): void {
    const world = this.world;
    this.road = buildRoad(world.track, this.preset, this.textures, world.biomes);
    this.scene.add(this.road.group);

    this.scenery = buildScenery(
      world.track, world.rng, this.preset, this.models,
      world.biomes, this.treeVariants, this.grassTuft,
    );
    this.scene.add(this.scenery.group);

    this.water = buildWater(world.track, world.biomes, this.preset);
    this.scene.add(this.water.group);

    this.paddies = buildPaddies(world.track, world.biomes);
    this.scene.add(this.paddies.group);

    this.pavements = buildPavements(world.track, world.biomes);
    this.scene.add(this.pavements.group);

    this.trackProps = new THREE.Group();
    this.trackProps.add(buildStartLine(world.track));
    this.trackProps.add(buildFinishLine(world.track, world.raceDistance));
    this.scene.add(this.trackProps);

    for (const pickup of world.pickups) {
      const rig = createPickupMesh(pickup.type);
      const at = world.track.toWorld(pickup.s, pickup.lateral);
      rig.root.position.set(at.x, at.y + 1.25, at.z);
      this.pickupRigs.set(pickup.id, rig);
      this.scene.add(rig.root);
    }

    this.crossingsGroup = buildCrossings(world.track, world.crossings);
    this.scene.add(this.crossingsGroup.group);

    for (const ped of world.pedestrians) {
      const rig = createPedestrianMesh(ped.colour, ped.kind, ped.id);
      rig.root.visible = false;
      this.pedRigs.set(ped.id, rig);
      this.scene.add(rig.root);
    }

    this.camLateral = world.player.lateral;
  }

  /** Swap in a fresh race (new seed means a new track, so this rebuilds). */
  rebuild(world: World): void {
    this.teardownWorld();
    this.world = world;
    const nextPreset = pickSky(world.seed);
    if (nextPreset.key !== this.preset.key) {
      this.preset = nextPreset;
      this.scene.remove(this.sky.mesh);
      this.sky.dispose();
      this.sky = createSky(this.preset);
      this.scene.add(this.sky.mesh);
      (this.scene.fog as THREE.FogExp2).color.set(this.preset.fog);
      (this.scene.fog as THREE.FogExp2).density = this.preset.fogDensity;
      this.sun.color.set(this.preset.sun);
      this.sun.intensity = this.preset.sunIntensity;
      this.hemi.color.set(this.preset.ambient);
      this.hemi.groundColor.set(this.preset.hemiGround);
      this.renderer.toneMappingExposure = this.preset.exposure;
    }
    this.shake.reset();
    this.buildWorld();
  }

  private teardownWorld(): void {
    for (const rig of this.bikeRigs.values()) {
      this.scene.remove(rig.root);
      rig.dispose();
    }
    this.bikeRigs.clear();
    for (const rig of this.riderRigs.values()) {
      rig.root.removeFromParent();
      rig.dispose();
    }
    this.riderRigs.clear();
    this.ragdolls.clear();
    this.crashFx.clear();
    this.downAnim.clear();

    for (const rig of this.carRigs.values()) {
      this.scene.remove(rig.root);
      rig.dispose();
    }
    this.carRigs.clear();
    for (const pool of this.carPool.values()) {
      for (const rig of pool) rig.dispose();
    }
    this.carPool.clear();

    for (const rig of this.pickupRigs.values()) {
      this.scene.remove(rig.root);
      rig.dispose();
    }
    this.pickupRigs.clear();

    for (const rig of this.pedRigs.values()) {
      this.scene.remove(rig.root);
      rig.dispose();
    }
    this.pedRigs.clear();

    if (this.crossingsGroup) {
      this.scene.remove(this.crossingsGroup.group);
      this.crossingsGroup.dispose();
      this.crossingsGroup = null;
    }

    if (this.road) {
      this.scene.remove(this.road.group);
      this.road.dispose();
      this.road = null;
    }
    if (this.scenery) {
      this.scene.remove(this.scenery.group);
      this.scenery.dispose();
      this.scenery = null;
    }
    if (this.trackProps) {
      this.scene.remove(this.trackProps);
      this.trackProps = null;
    }
    if (this.water) {
      this.scene.remove(this.water.group);
      this.water.dispose();
      this.water = null;
    }
    if (this.paddies) {
      this.scene.remove(this.paddies.group);
      this.paddies.dispose();
      this.paddies = null;
    }
    if (this.pavements) {
      this.scene.remove(this.pavements.group);
      this.pavements.dispose();
      this.pavements = null;
    }
  }

  // -------------------------------------------------------------- quality
  private applyQuality(): void {
    const high = this.quality === 'high';
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, high ? 1.75 : 1));
    this.renderer.shadowMap.enabled = high;
    this.sun.castShadow = high;
    this.sun.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
    this.bloom.enabled = high;
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !high) m.castShadow = false;
    });
    this.resize();
  }

  setQuality(level: QualityLevel): void {
    if (this.quality === level) return;
    this.quality = level;
    this.autoQuality = false;
    this.applyQuality();
  }

  private monitorPerformance(dtMs: number): void {
    if (!this.autoQuality || this.quality === 'low') return;
    this.frameEma = this.frameEma * 0.92 + dtMs * 0.08;
    // Sustained sub-40fps means the GPU is not keeping up; drop once and stay.
    if (this.frameEma > 25) {
      this.slowFrames++;
      if (this.slowFrames > 120) {
        console.info('[roadbrush] dropping to low quality to hold framerate');
        this.quality = 'low';
        this.applyQuality();
      }
    } else {
      this.slowFrames = Math.max(0, this.slowFrames - 2);
    }
  }

  // ---------------------------------------------------------------- events
  /** Turn simulation events into sparks, dust and camera shake. */
  handleEvents(events: readonly SimEvent[]): void {
    const player = this.world.player;
    for (const e of events) {
      switch (e.type) {
        case 'crash': {
          const at = this.worldPos(e.racer, 0.5);
          this.particles.sparks(at, e.racer === player ? 34 : 18, 0xffc061);
          if (e.racer === player) this.shake.add(0.75);
          else if (this.near(e.racer)) this.shake.add(0.16);
          break;
        }
        case 'scrape': {
          const at = this.worldPos(e.racer, 0.4);
          this.particles.sparks(at, 8, 0xffe08a);
          if (e.racer === player) this.shake.add(0.2);
          break;
        }
        case 'hit': {
          const at = this.worldPos(e.victim, 1.2);
          this.particles.sparks(at, e.weapon === 'fist' ? 8 : 14, 0xff7a4a);
          if (e.victim === player) this.shake.add(0.34);
          else if (e.attacker === player) this.shake.add(0.12);
          break;
        }
        case 'bump':
          if (e.a === player || e.b === player) this.shake.add(0.1);
          break;
        case 'pickup': {
          const rig = this.pickupRigs.get(e.pickup.id);
          if (rig) rig.root.visible = false;
          const tint = e.kind === 'health' ? 0x25d366 : e.kind === 'boost' ? 0x3aa8ff : 0xd98b3a;
          this.particles.burst(this.worldPos(e.racer, 1.1), tint);
          break;
        }
        case 'holeshot':
          this.shake.add(0.3);
          break;
        case 'pedestrianHit': {
          const at = this.world.track.toWorld(e.pedestrian.s, e.pedestrian.lateral, this.tmpSample);
          this.particles.burst(this.tmpVec.set(at.x, at.y + 1, at.z), 0xffd08a, 12);
          if (e.racer === player) this.shake.add(0.22);
          break;
        }
        default:
          break;
      }
    }
  }

  private near(r: Racer): boolean {
    return Math.abs(r.s - this.world.player.s) < 45;
  }

  private worldPos(r: Racer, height: number): THREE.Vector3 {
    const p = this.world.track.toWorld(r.s, r.lateral, this.tmpSample);
    return this.tmpVec.set(p.x, p.y + height, p.z);
  }

  // ----------------------------------------------------------------- frame
  render(dt: number, playerInput?: Readonly<RacerInput>): void {
    this.time += dt;
    this.playerBrake = playerInput?.brake ?? 0;
    this.syncRacers(dt);
    this.syncTraffic();
    this.syncPickups(dt);
    this.syncPedestrians(dt);

    this.particles.update(dt);
    this.shake.update(dt);
    this.sky.update(this.time);
    this.updateCamera(dt, playerInput);
    this.updateSun();

    const start = performance.now();
    this.composer.render();
    this.monitorPerformance(performance.now() - start + dt * 1000);
  }

  private syncRacers(dt: number): void {
    const world = this.world;
    const field = world.field;
    const live = new Set<number>();

    for (const r of field) {
      live.add(r.id);
      let bike = this.bikeRigs.get(r.id);
      if (!bike) {
        bike = createBikeRig(r.color, r.kind);
        this.bikeRigs.set(r.id, bike);
        this.scene.add(bike.root);

        const accent = r.kind === 'cop' ? 0xdfe4ea : 0xf0f0ea;
        const rider = createRiderRig(r.color, accent, r.kind);
        this.riderRigs.set(r.id, rider);
        bike.chassis.add(rider.root);
        rider.root.position.copy(bike.seatOffset);

        this.ragdolls.set(r.id, new Ragdoll());
        this.crashFx.set(r.id, { tumble: new BikeTumble(), standT: 0, runPhase: 0 });
      }
      this.poseRacer(bike, r, dt);
    }

    // Retire rigs for racers that have left the field (a cop giving up).
    for (const [id, bike] of this.bikeRigs) {
      if (live.has(id)) continue;
      this.scene.remove(bike.root);
      bike.dispose();
      this.bikeRigs.delete(id);
      const rider = this.riderRigs.get(id);
      if (rider) {
        rider.root.removeFromParent();
        rider.dispose();
        this.riderRigs.delete(id);
      }
      this.ragdolls.delete(id);
      this.crashFx.delete(id);
      this.downAnim.delete(id);
    }
  }

  private poseRacer(bike: BikeRig, r: Racer, dt: number): void {
    const track = this.world.track;
    const rider = this.riderRigs.get(r.id);
    const ragdoll = this.ragdolls.get(r.id);
    const fx = this.crashFx.get(r.id);
    if (!rider || !ragdoll || !fx) return;

    const p = track.toWorld(r.s, r.lateral, this.tmpSample);
    bike.root.position.set(p.x, p.y, p.z);
    bike.root.rotation.y = p.heading;

    const wasDown = (this.downAnim.get(r.id) ?? 0) > 0.5;
    const isDown = r.state === 'down';
    const down = damp(this.downAnim.get(r.id) ?? 0, isDown ? 1 : 0, isDown ? 12 : 5, dt);
    this.downAnim.set(r.id, down);

    // ---------------------------------------------------------- the bike
    bike.frontWheel.rotation.x = -r.wheelAngle;
    bike.rearWheel.rotation.x = -r.wheelAngle;

    if (isDown) {
      // Real rigid-body tumble: gravity, spin, bounce, then grind to a stop.
      fx.tumble.step(dt);
      if (r.riderPhase === 'lifting' || r.riderPhase === 'mounting') {
        // Being hauled back onto its wheels.
        fx.tumble.quaternion.slerp(UPRIGHT, Math.min(1, dt * 4.5));
        fx.tumble.offset.multiplyScalar(Math.max(0, 1 - dt * 5));
      }
      bike.chassis.position.copy(fx.tumble.offset);
      bike.chassis.quaternion.copy(fx.tumble.quaternion);
      bike.setDive(0);
      // No contact patch while it is cartwheeling through the air.
      const grounded = fx.tumble.offset.y < 0.35;
      for (const blob of bike.contactShadows) blob.visible = grounded;
    } else {
      for (const blob of bike.contactShadows) blob.visible = true;
      bike.chassis.position.set(0, 0, 0);
      bike.chassis.quaternion.identity();
      bike.chassis.rotation.x = 0;
      bike.chassis.rotation.y = 0;
      // Lean: positive lean tips to the rider's right, which is -Z rotation.
      bike.chassis.rotation.z = -r.lean * (1 - down);
      // Fork dive under braking and from the weight transfer of hard accel.
      const braking = r.id === this.world.player.id ? this.playerBrake : 0;
      const dive = clamp(braking * 0.85 + (r.stagger > 0 ? 0.3 : 0), 0, 1);
      // Smooth the travel so the forks settle rather than snapping.
      fx.standT = damp(fx.standT, dive, 9, dt);
      bike.setDive(fx.standT);
      // Counter-steer the front wheel into the corner.
      bike.steering.rotation.y = clamp(-r.lean * 0.35, -0.3, 0.3);
    }

    if (bike.lightBar) {
      const phase = Math.floor(this.time * 6) % 2;
      const lamps = bike.lightBar.children as THREE.Mesh[];
      lamps.forEach((lamp, i) => {
        const m = lamp.material as THREE.MeshStandardMaterial;
        m.emissiveIntensity = i === phase ? 4.5 : 0.25;
      });
    }

    // --------------------------------------------------------- the rider
    if (isDown && !wasDown) {
      // Just went down: snapshot the rider in world space and throw them.
      this.launchRagdoll(r, bike, rider, ragdoll, fx);
    }

    if (isDown) {
      if (r.riderPhase === 'tumble' && ragdoll.active) {
        ragdoll.step(dt, p.y);
        ragdoll.writeInto(rider.skeleton);
        rider.apply();
      } else {
        // Up, back to the bike, pick it up, get on.
        this.poseRecoveringRider(r, rider, ragdoll, fx, dt);
      }
    } else {
      if (rider.root.parent !== bike.chassis) {
        // Back on board.
        rider.root.removeFromParent();
        bike.chassis.add(rider.root);
        ragdoll.stop();
        fx.tumble.stop();
        fx.standT = 0;
      }
      rider.root.position.copy(bike.seatOffset);
      rider.root.rotation.set(0, 0, 0);
      rider.root.scale.setScalar(1);

      const speedNorm = clamp(r.speed / BIKE.maxSpeed, 0, 1);
      const braking = r.id === this.world.player.id ? this.playerBrake : 0;
      poseRiding(rider.skeleton, {
        tuck: speedNorm * speedNorm,
        lean: clamp(r.lean / BIKE.leanMax, -1, 1),
        brake: braking,
        swingDir: r.attackDir,
        swing: swingProgress(r),
      });
      rider.apply();
      rider.setClubVisible(r.weapon !== 'fist', r.attackDir);
    }

    // --- surface FX ------------------------------------------------------
    // Only spend particles on riders the camera can actually see.
    const visible = Math.abs(r.s - this.world.player.s) < 70;
    if (visible) {
      if (r.state === 'ride' && track.isOffRoad(r.lateral) && r.speed > 6 && Math.random() < 0.55) {
        this.particles.dust(this.worldPos(r, 0.15), 2);
      } else if (isDown && r.speed > 5 && Math.random() < 0.6) {
        this.particles.sparks(this.worldPos(r, 0.25), 3, 0xffb066);
      }
    }
  }

  /** Detach the rider and hand them to the physics solver. */
  private launchRagdoll(
    r: Racer,
    bike: BikeRig,
    rider: RiderRig,
    ragdoll: Ragdoll,
    fx: CrashFx,
  ): void {
    // Snapshot the current pose in world space before re-parenting.
    rider.root.updateWorldMatrix(true, false);
    for (let i = 0; i < rider.skeleton.length; i++) {
      scratchSkeleton[i].copy(rider.skeleton[i]).applyMatrix4(rider.root.matrixWorld);
    }
    rider.root.removeFromParent();
    this.scene.add(rider.root);
    rider.root.position.set(0, 0, 0);
    rider.root.rotation.set(0, 0, 0);

    // Inherit the bike's velocity, plus an upward kick and a tumble.
    const heading = this.world.track.headingAt(r.s);
    const severity = 0.4 + r.downSeverity * 0.6;
    this.tmpVec.set(
      -Math.sin(heading) * r.speed,
      3.2 + severity * 4.5,
      -Math.cos(heading) * r.speed,
    );
    this.tmpVec2.set(
      (Math.random() - 0.5) * 9 * severity,
      (Math.random() - 0.5) * 5 * severity,
      (Math.random() - 0.5) * 9 * severity,
    );
    ragdoll.launch(scratchSkeleton, this.tmpVec, this.tmpVec2);
    ragdoll.writeInto(rider.skeleton);
    rider.apply();
    rider.setClubVisible(false, 0);

    // Kick the bike into its own tumble.
    fx.tumble.launch(r.downSeverity, r.speed);
    fx.standT = 0;
    fx.runPhase = 0;
  }

  /** Rider is up: walk back, haul the bike upright, climb on. */
  private poseRecoveringRider(
    r: Racer,
    rider: RiderRig,
    ragdoll: Ragdoll,
    fx: CrashFx,
    dt: number,
  ): void {
    if (ragdoll.active) ragdoll.stop();
    if (rider.root.parent !== this.scene) {
      rider.root.removeFromParent();
      this.scene.add(rider.root);
    }

    // The simulation owns where they are; mirror it exactly so the two never
    // drift apart.
    const at = this.world.track.toWorld(
      r.s + r.riderThrow,
      r.lateral + r.riderLateralThrow,
      this.tmpSample,
    );
    rider.root.position.set(at.x, at.y, at.z);
    // Facing the bike they are heading for.
    rider.root.rotation.set(0, at.heading + Math.PI, 0);

    switch (r.riderPhase) {
      case 'standing':
        // Getting off the floor: blend up out of the crouch, no stride yet.
        fx.standT = Math.min(1, fx.standT + dt * 2.2);
        poseRunning(rider.skeleton, 0, fx.standT);
        break;

      case 'running':
        fx.standT = Math.min(1, fx.standT + dt * 3.2);
        fx.runPhase += dt * 11;
        poseRunning(rider.skeleton, fx.runPhase, fx.standT);
        break;

      case 'lifting': {
        // Standing over the bike, heaving it upright: crouch down and pull up.
        fx.runPhase += dt * 2;
        const pull = 0.5 - Math.cos(Math.min(Math.PI, fx.runPhase)) * 0.5;
        poseRunning(rider.skeleton, 0, 0.45 + pull * 0.5);
        rider.root.rotation.y = at.heading + Math.PI * 0.5;
        break;
      }

      case 'mounting':
        // Leg over: rise into the riding crouch as they settle onto the seat.
        fx.runPhase += dt;
        poseRunning(rider.skeleton, 0, 1);
        rider.root.rotation.y = at.heading + Math.PI * 0.25;
        break;

      default:
        poseRunning(rider.skeleton, fx.runPhase, fx.standT);
        break;
    }
    rider.apply();
  }

  private syncTraffic(): void {
    const world = this.world;
    const live = new Set<number>();

    for (const car of world.traffic.cars) {
      if (!car.active) continue;
      live.add(car.id);
      let rig = this.carRigs.get(car.id);
      // A recycled car can change type, which means a different body.
      if (rig && rig.type.key !== car.type.key) {
        this.releaseCar(car.id, rig);
        rig = undefined;
      }
      if (!rig) {
        rig = this.acquireCar(car);
        this.carRigs.set(car.id, rig);
        this.scene.add(rig.root);
      }
      this.poseCar(rig, car);
    }

    for (const [id, rig] of this.carRigs) {
      if (!live.has(id)) this.releaseCar(id, rig);
    }
  }

  private acquireCar(car: Car): CarRig {
    const pool = this.carPool.get(car.type.key);
    const reused = pool?.pop();
    if (reused) {
      if (reused.bodyMat) reused.bodyMat.color.setHex(car.color);
      return reused;
    }
    const options = CAR_MODELS[car.type.key];
    if (this.models.ok && options?.length) {
      // Pick a body variant deterministically from the car's identity.
      const name = options[(car.id + car.laneIndex) % options.length];
      const model = this.models.cars.get(name);
      if (model) return createCarFromModel(model, car.type);
    }
    return createCarMesh(car.type, car.color);
  }

  private releaseCar(id: number, rig: CarRig): void {
    this.scene.remove(rig.root);
    this.carRigs.delete(id);
    let pool = this.carPool.get(rig.type.key);
    if (!pool) {
      pool = [];
      this.carPool.set(rig.type.key, pool);
    }
    // Cap the pool so a long race cannot leak rigs.
    if (pool.length < 8) pool.push(rig);
    else rig.dispose();
  }

  private poseCar(rig: CarRig, car: Car): void {
    const p = this.world.track.toWorld(car.s, car.lateral, this.tmpSample);
    rig.root.position.set(p.x, p.y, p.z);
    // Oncoming cars face the other way down the track.
    rig.root.rotation.y = p.heading + (car.dir === 1 ? 0 : Math.PI);
  }

  private syncPickups(dt: number): void {
    for (const pickup of this.world.pickups) {
      const rig = this.pickupRigs.get(pickup.id);
      if (!rig) continue;
      if (pickup.taken) {
        rig.root.visible = false;
        continue;
      }
      // Only animate the ones you can actually see.
      const ds = pickup.s - this.world.player.s;
      const visible = ds > -30 && ds < 320;
      rig.root.visible = visible;
      if (visible) {
        rig.spin.rotation.y += dt * 2.2;
        rig.root.position.y += Math.sin(this.time * 2 + pickup.id) * dt * 0.35;
      }
    }
  }

  /** Position and animate the crowd near the player. */
  private syncPedestrians(_dt: number): void {
    const playerS = this.world.player.s;
    for (const ped of this.world.pedestrians) {
      const rig = this.pedRigs.get(ped.id);
      if (!rig) continue;
      const ds = ped.s - playerS;
      const visible = ds > -60 && ds < 300;
      rig.root.visible = visible;
      if (!visible) continue;

      const at = this.world.track.toWorld(ped.s, ped.lateral, this.tmpSample);
      rig.root.position.set(at.x, at.y + ped.height, at.z);

      if (ped.state === 'flying' || ped.state === 'down') {
        // Cartwheel through the air, then lie there.
        rig.root.rotation.set(ped.spin, at.heading, ped.spin * 0.6);
        rig.body.rotation.set(ped.state === 'down' ? Math.PI / 2 : 0, 0, 0);
        rig.body.position.y = ped.state === 'down' ? 0.25 : 0;
        continue;
      }

      rig.body.rotation.set(0, 0, 0);
      rig.body.position.y = 0;

      if (ped.state === 'walking' || ped.state === 'strolling') {
        // Crossers face across the road; walkers face along the pavement.
        rig.root.rotation.set(
          0,
          ped.state === 'strolling'
            ? at.heading + (ped.along > 0 ? 0 : Math.PI)
            : at.heading - ped.dir * Math.PI / 2,
          0,
        );
        const swing = Math.sin(this.time * ped.speed * 4.5 + ped.id) * 0.55;
        rig.legL.rotation.x = swing;
        rig.legR.rotation.x = -swing;
        rig.armL.rotation.x = -swing * 0.7;
        rig.armR.rotation.x = swing * 0.7;
      } else {
        // Waiting or cheering: face the road, bounce, wave.
        rig.root.rotation.set(0, at.heading + (ped.lateral > 0 ? Math.PI / 2 : -Math.PI / 2), 0);
        rig.legL.rotation.x = 0;
        rig.legR.rotation.x = 0;
        if (ped.state === 'cheering') {
          const t = this.time * 6 + ped.timer;
          rig.root.position.y = at.y + Math.abs(Math.sin(t)) * 0.12;
          rig.armL.rotation.x = -2.2 + Math.sin(t) * 0.5;
          rig.armR.rotation.x = -2.2 + Math.cos(t) * 0.5;
        } else {
          rig.armL.rotation.x = 0;
          rig.armR.rotation.x = 0;
        }
      }
    }
  }

  private updateCamera(dt: number, playerInput?: Readonly<RacerInput>): void {
    const world = this.world;
    const p = world.player;
    const track = world.track;
    const speedNorm = clamp(p.speed / BIKE.maxSpeed, 0, 1);

    this.camLateral = damp(this.camLateral, p.lateral, 3.4, dt);
    const down = this.downAnim.get(p.id) ?? 0;
    const back = CAM.back + speedNorm * CAM.backSpeedGain + down * 2.4;

    const behind = track.toWorld(p.s - back, this.camLateral, this.tmpSample);
    const height = CAM.height + down * 1.5;
    this.camera.position.set(behind.x, behind.y + height, behind.z);

    // Bias the look-at toward the middle of the road so the camera settles
    // rather than tracking every twitch. On a divided stretch the middle of
    // the ROAD is the island, though - biasing toward that swings the camera
    // off the carriageway and leaves the rider at the edge of frame. Aim at
    // the middle of the carriageway they are actually on.
    const lookMedian = track.medianAt(p.s + CAM.lookAhead);
    const lookCentre = lookMedian > 0
      ? Math.sign(p.lateral || 1) * (lookMedian + track.halfWidth * 0.5)
      : 0;
    const lookLateral = lookCentre + (p.lateral - lookCentre) * 0.55;
    const ahead = track.toWorld(p.s + CAM.lookAhead, lookLateral, this.tmpSample);
    this.tmpVec2.set(ahead.x, ahead.y + CAM.lookHeight, ahead.z);

    const shakeOffset = this.shake.offset(this.tmpVec);
    this.camera.position.add(shakeOffset);
    this.camera.lookAt(this.tmpVec2);
    this.camera.rotateZ(this.shake.roll);

    const boost = p.boostTimer > 0 ? 1 : 0;
    const targetFov = CAM.baseFov + speedNorm * CAM.speedFov + boost * CAM.boostFov;
    this.camera.fov = damp(this.camera.fov, targetFov, 4, dt);
    this.camera.updateProjectionMatrix();

    // Sky and distant ridges ride along so they never gain parallax.
    this.sky.mesh.position.copy(this.camera.position);
    if (this.scenery) {
      this.scenery.mountains.position.set(this.camera.position.x, 0, this.camera.position.z);
    }

    // Brake lights follow the player's actual input.
    const playerRig = this.bikeRigs.get(p.id);
    if (playerRig) {
      const braking = (playerInput?.brake ?? 0) > 0.1;
      playerRig.brakeLight.emissiveIntensity = braking ? 2.6 : 0.25;
    }
  }

  private updateSun(): void {
    // Keep the shadow frustum centred on the player.
    const p = this.world.player;
    const at = this.world.track.toWorld(p.s + 12, p.lateral, this.tmpSample);
    const dir = this.preset.sunDir;
    this.sun.position.set(at.x + dir[0] * 90, at.y + dir[1] * 90 + 40, at.z + dir[2] * 90);
    this.sun.target.position.set(at.x, at.y, at.z);
    this.sun.target.updateMatrixWorld();
  }

  // ------------------------------------------------------------------ misc
  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  dispose(): void {
    this.teardownWorld();
    this.particles.dispose();
    this.sky.dispose();
    this.textures.dispose();
    this.models.dispose();
    this.composer.dispose();
    disposeBikeGeometry();
    disposeCarGeometry();
    this.renderer.dispose();
  }
}

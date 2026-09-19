// Shared simulation types. The renderer, audio layer and UI all read these, so
// renaming a field here surfaces every call site at build time.

export type RacerKind = 'player' | 'rival' | 'cop';
export type RacerState = 'ride' | 'down' | 'finished' | 'busted';
/**
 * What a downed rider is doing. The whole sequence, in order: hit the deck and
 * slide (distance set by how fast you were going), pick yourself up, walk back
 * to the bike, haul it upright, get on, ride away.
 */
export type RiderPhase = 'tumble' | 'standing' | 'running' | 'lifting' | 'mounting';
export type WeaponType = 'fist' | 'club' | 'baton';
export type PickupKind = 'health' | 'club' | 'boost';
export type RaceState = 'countdown' | 'racing' | 'finished' | 'busted' | 'wasted';
export type EndReason = 'finished' | 'busted' | 'wasted';
export type DifficultyKey = 'easy' | 'normal' | 'hard';
export type CrashCause = 'traffic' | 'barrier';

/** Deterministic PRNG with a few conveniences hung off it. */
export interface Rng {
  (): number;
  range(lo: number, hi: number): number;
  int(lo: number, hi: number): number;
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
}

export interface RacerInput {
  throttle: number;
  brake: number;
  steer: number;
  attackLeft: boolean;
  attackRight: boolean;
}

export interface AiState {
  planTimer: number;
  desiredLateral: number;
  braking: number;
  attackUrge: number;
  giveUpTimer: number;
  bustProgress: number;
  escapeTimer: number;
}

export interface Racer {
  id: number;
  kind: RacerKind;
  name: string;
  color: number;

  /** Distance travelled along the track centreline, in metres. */
  s: number;
  /** Signed offset from the centreline; positive is the rider's right. */
  lateral: number;
  speed: number;
  lean: number;

  speedScale: number;
  aggression: number;

  health: number;
  maxHealth: number;
  state: RacerState;
  downTimer: number;
  downSeverity: number;
  sinceDamage: number;
  stagger: number;
  staggerPush: number;

  attackTimer: number;
  attackCooldown: number;
  attackDir: -1 | 0 | 1;
  swingResolved: boolean;
  weapon: WeaponType;
  weaponTimer: number;
  boostTimer: number;

  wheelAngle: number;
  bumpCooldown: number;
  /** Stops a sustained barrier graze re-damaging you every single tick. */
  scrapeCooldown: number;
  /** Metres the rider is currently separated from their bike. */
  riderThrow: number;
  riderThrowTarget: number;
  /** Sideways displacement of the rider - a barrier crash throws them over it. */
  riderLateralThrow: number;
  riderPhase: RiderPhase;
  place: number;
  finishTime: number | null;
  knockdowns: number;
  hitsLanded: number;
  bestSpeed: number;
  ai: AiState | null;
}

export interface CarType {
  key: string;
  length: number;
  width: number;
  height: number;
  weight: number;
}

export interface Car {
  id: number;
  s: number;
  lateral: number;
  /** Always positive; combine with `dir` for signed track-space velocity. */
  speed: number;
  dir: 1 | -1;
  type: CarType;
  color: number;
  laneIndex: number;
  active: boolean;
  swerve: number;
  swervePhase: number;
  /** Speed the driver wants to travel at, before braking. */
  cruise: number;
  /** 0..1 how hard they are currently on the brakes. */
  brake: number;
}

export interface Pickup {
  id: number;
  s: number;
  lateral: number;
  type: PickupKind;
  taken: boolean;
}

export interface TrackSample {
  x: number;
  y: number;
  z: number;
  heading: number;
  curvature: number;
}

export interface StandingEntry {
  name: string;
  place: number;
  time: number | null;
  isPlayer: boolean;
  s: number;
}

export interface RaceResult {
  reason: EndReason;
  place: number;
  time: number;
  distance: number;
  raceDistance: number;
  topSpeed: number;
  takedowns: number;
  crashes: number;
  standings: StandingEntry[];
}

/**
 * Everything the sim reports upward. The renderer and audio layer switch on
 * `type`, so adding a case here forces both to acknowledge it.
 */
export type SimEvent =
  | { type: 'countdown'; value: number }
  | { type: 'go' }
  | { type: 'holeshot' }
  | { type: 'remount'; racer: Racer }
  | { type: 'crash'; racer: Racer; cause: CrashCause; car?: Car; closing?: number; fatal: boolean }
  | { type: 'scrape'; racer: Racer; car: Car; fatal: boolean }
  | { type: 'bump'; a: Racer; b: Racer }
  | { type: 'hit'; attacker: Racer; victim: Racer; damage: number; weapon: WeaponType; fatal: boolean; dir: -1 | 1 }
  | { type: 'whiff'; attacker: Racer; dir: -1 | 1 }
  | { type: 'pickup'; racer: Racer; pickup: Pickup; kind: PickupKind }
  | { type: 'finish'; racer: Racer }
  | { type: 'placeChange'; place: number; from: number }
  | { type: 'copSpawn'; cop: Racer }
  | { type: 'copGiveUp'; cop: Racer; reason: 'beaten' | 'outrun' }
  | { type: 'pedestrianHit'; racer: Racer; pedestrian: PedestrianRef; impact: number }
  | { type: 'raceEnd'; reason: EndReason; result: RaceResult };

/** Structural shape of a pedestrian, kept here to avoid a circular import. */
export interface PedestrianRef {
  id: number;
  s: number;
  lateral: number;
  kind: string;
}

export type SimEventType = SimEvent['type'];

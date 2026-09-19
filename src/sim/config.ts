// Central tuning table. Everything gameplay-related lives here so the feel of
// the game can be adjusted without hunting through the simulation code.

import type { DifficultyKey } from './types';

export const TRACK = {
  /** Distance to the finish line, in metres. */
  raceDistance: 5200,
  /** Extra track generated past the finish so the world does not end abruptly. */
  runout: 600,
  /** Half the drivable asphalt width, in metres. */
  halfWidth: 9,
  /** Lateral distance past the asphalt edge before you hit scenery and crash. */
  shoulder: 4.5,
  /** Centreline is sampled at this spacing and interpolated in between. */
  sampleStep: 4,
  laneCentres: [-6.75, -2.25, 2.25, 6.75],
};

export const BIKE = {
  maxSpeed: 74, // m/s (~266 km/h)
  accelRate: 0.62, // exponential approach rate toward target speed
  coastDecel: 6.5, // m/s^2 when off throttle
  brakeDecel: 26, // m/s^2 when braking
  steerSpeed: 13.5, // m/s of lateral movement at full lock, full speed
  steerLowSpeed: 0.34, // fraction of steering authority at a standstill
  driftFactor: 0.75, // how hard corners push you toward the outside
  offroadGrip: 0.56, // speed multiplier once both wheels are on dirt
  offroadRumble: 2.4,
  leanMax: 0.62, // radians, visual only
  boostMultiplier: 1.26,
  boostDuration: 3.2,
};

export const COMBAT = {
  reach: 3.0, // longitudinal reach, metres
  lateralReach: 3.6, // sideways reach, metres
  cooldown: 0.42,
  windup: 0.09,
  swingTime: 0.26,
  fistDamage: 11,
  clubDamage: 27,
  // Cops are trying to pull you over, not kill you. A baton that hit as hard
  // as a club would empty your health bar before a bust could ever land.
  batonDamage: 14,
  staggerTime: 0.55,
  knockLateral: 1.35, // sideways shove applied to whoever gets hit
  speedPenalty: 0.94, // victim's speed multiplier on a clean hit
  weaponDuration: 22, // seconds a picked-up club lasts
};

export const HEALTH = {
  max: 100,
  regenDelay: 4.5,
  regenRate: 1.6,
  // A crash costs you time (you are on the tarmac for seconds); health is
  // mostly something you lose in a fight, not to scenery.
  crashDamage: 9,
  scrapeDamage: 5,
  barrierDamage: 8,
};

export const CRASH = {
  /** Closing speed above which a collision becomes a full crash. */
  hardImpactSpeed: 15,
  playerDownTime: 2.3,
  rivalDownTime: 2.9,
  knockoutDownTime: 3.6,
  /** Speed you are put back on the bike with. */
  remountSpeed: 9,
  /** Metres you lose when you go down. */
  setback: 6,
  rivalRespawnHealth: 45,

  // --- going down -------------------------------------------------------
  /**
   * Fraction of your speed you keep when you hit the deck. You tumble and
   * slide rather than stopping dead, so a 250 km/h crash throws you a long
   * way down the road and a slow one barely moves you.
   */
  slideRetain: 0.55,
  /** How fast the slide scrubs off. Lower means a longer tumble. */
  slideDrag: 2.1,
  /** How much longer a heavy crash keeps you down than a light one. */
  severityTimeGain: 0.5,
  /**
   * The rider picks the bike up by themselves; holding the throttle makes
   * them hustle back to it, so recovery is partly in the player's hands.
   */
  hustleBonus: 0.9,
};

export const TRAFFIC = {
  // Road Rash traffic is sparse - an occasional car to dodge, not a jam.
  // Density is what makes the road readable at 250 km/h.
  count: 10,
  spawnAhead: 460,
  spawnBehind: 150,
  minGap: 70,
  sameDirSpeed: [17, 29] as [number, number],
  oncomingSpeed: [21, 33] as [number, number],
  halfLength: 2.45,
  halfWidth: 1.05,
};

export const RIVALS = {
  /** Rivals on the grid. With the player that makes an 8-strong field. */
  count: 7,
  names: [
    'VIPER', 'TANK', 'NATASHA', 'BISCUIT', 'AXEL', 'RONIN', 'SLICE',
    'HAWK', 'MERCY', 'DIESEL', 'KOJI', 'RAZOR',
  ],
  /** Per-rival skill floor/ceiling as a fraction of max speed. */
  skill: [0.94, 1.03] as [number, number],
  aggression: [0.25, 0.85] as [number, number],
  /** Rubber-band: how much faster rivals go when trailing badly. */
  catchupGain: 0.1,
  catchupRange: 260,
  attackRange: 3.2,
};

export const PICKUPS = {
  spacing: [220, 480] as [number, number],
  healthAmount: 30,
  weights: { health: 0.4, club: 0.32, boost: 0.28 },
  radius: 2.6,
};

export const BIKE_HALF = { length: 1.25, width: 0.55 };

export interface DifficultyPreset {
  label: string;
  rivalSkill: number;
  traffic: number;
  aggression: number;
  distance: number;
}

export const DIFFICULTY: Record<DifficultyKey, DifficultyPreset> = {
  easy: { label: 'ROOKIE', rivalSkill: 0.93, traffic: 0.7, aggression: 0.6, distance: 3800 },
  normal: { label: 'RASHER', rivalSkill: 1.0, traffic: 1.0, aggression: 1.0, distance: 5200 },
  hard: { label: 'OUTLAW', rivalSkill: 1.045, traffic: 1.4, aggression: 1.5, distance: 6600 },
};

export const POLICE = {
  heatMax: 100,
  /** Speed (m/s) above which you start attracting attention. */
  speedThreshold: 52,
  speedHeat: 5.5,
  hitHeat: 9,
  crashHeat: 6,
  copHitHeat: 22,
  heatDecay: 2.4,
  spawnBehind: 65,
  /** Seconds a cop must stay alongside you to make the bust. */
  bustTime: 2.2,
  bustRange: 4.2,
  bustLateral: 2.8,
  bustDecay: 0.7,
  /** Lead you must hold, for `escapeTime`, to lose them. */
  escapeDistance: 185,
  escapeTime: 2.6,
  giveUpKnockdowns: 3,
};

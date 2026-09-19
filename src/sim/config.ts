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

  // --- divided sections ---------------------------------------------------
  /**
   * Some stretches are a divided highway with a median down the middle. The
   * road keeps its overall width; the centre simply stops being drivable, so
   * the lane layout and all the traffic logic are unaffected.
   */
  medianHalfWidth: 1.7,
  medianLength: [420, 900] as [number, number],
  medianGap: [600, 1500] as [number, number],
  /**
   * Some splits are wide enough to be an island, with a route either side of
   * it. The carriageways move outward to make room, so each keeps its full
   * width and the player genuinely picks a side.
   */
  forkHalfWidth: 9,
  forkChance: 0.45,
  /** A fork runs for a kilometre or more: committing to a side has to matter. */
  forkLength: [850, 1700] as [number, number],
  /** Distance over which the median opens up and closes again. */
  medianRamp: 130,
  /** Narrower than this and the median is paint, not grass. */
  medianMinEffective: 1.0,
  /** Clipping the edge of the median is fine; only being in it counts. */
  medianForgiveness: 0.45,
  /** Once an island is this wide it is planted, and hitting it is a crash. */
  forkImpassableFrom: 3.5,

  /** How far the sea sits below the road along a coast section. */
  coastDrop: 5.5,
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
  /** How strongly gradient pulls on you. 1 would be true gravity; this is
   *  arcade, so it is exaggerated enough to feel without being punishing. */
  slopeFactor: 3.2,
  /** Top speed multiplier allowed while descending. */
  downhillOverspeed: 1.1,
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
  /**
   * Speed above which clipping the barrier throws you off. Below it you just
   * grind along it and lose speed - being binned at walking pace for touching
   * a guardrail is not a crash, it is an annoyance.
   */
  barrierCrashSpeed: 18,
  /** Minimum gap between barrier scrapes doing damage. */
  scrapeInterval: 0.4,
  playerDownTime: 2.3,
  rivalDownTime: 2.9,
  knockoutDownTime: 3.6,
  /** Speed you are put back on the bike with. */
  remountSpeed: 9,
  /** Metres you lose when you go down. */
  setback: 6,
  rivalRespawnHealth: 45,

  // --- going down -------------------------------------------------------
  /** How long the rider tumbles before scrambling up, at zero severity. */
  tumbleTime: 0.55,
  tumbleSeverityGain: 0.45,
  /** Rivals are in less of a hurry to get up than you are. */
  rivalTumbleScale: 1.35,
  /** Extra time on the floor when a hit knocks you out cold. */
  knockoutExtra: 1.2,
  /** Metres the rider is thrown, per m/s of speed at the moment of impact. */
  throwPerSpeed: 0.2,
  throwMin: 1.5,
  throwMax: 16,
  /** How fast the rider runs back to the bike. */
  riderRunSpeed: 5.5,
  /** Getting back on your feet. */
  standTime: 0.55,
  /** Hauling the bike back upright. */
  liftTime: 0.85,
  /** Swinging a leg over and settling. */
  mountTime: 0.45,
  /** How far sideways a heavy crash throws the rider - over the guardrail. */
  lateralThrow: 3.4,
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
  /** How far ahead a driver looks for a bike in their lane. */
  lookAhead: 34,
  /** Lateral band a driver treats as "in my lane". */
  avoidWidth: 2.2,
  brakeDecel: 18,
  accel: 5,
  /** Gap a driver tries to leave behind a rider, in metres. */
  followGap: 7,
};

export const RIVALS = {
  /** Rivals on the grid. With the player that makes an 8-strong field. */
  count: 7,
  names: [
    'VIPER', 'TANK', 'NATASHA', 'BISCUIT', 'AXEL', 'RONIN', 'SLICE',
    'HAWK', 'MERCY', 'DIESEL', 'KOJI', 'RAZOR',
  ],
  /** Per-rival skill floor/ceiling as a fraction of max speed. */
  skill: [0.97, 1.06] as [number, number],
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
  /** Multiplier on how fast you attract police attention. */
  police: number;
}

export const DIFFICULTY: Record<DifficultyKey, DifficultyPreset> = {
  easy: { label: 'ROOKIE', rivalSkill: 0.92, traffic: 0.7, aggression: 0.6, distance: 3800, police: 1.4 },
  normal: { label: 'RASHER', rivalSkill: 1.02, traffic: 1.0, aggression: 1.0, distance: 5200, police: 1.8 },
  hard: { label: 'OUTLAW', rivalSkill: 1.035, traffic: 1.4, aggression: 1.5, distance: 6600, police: 2.2 },
};

export const POLICE = {
  heatMax: 100,
  /** Speed (m/s) above which you start attracting attention. */
  speedThreshold: 55,
  // Heat builds slowly: a patrol should be an event you dread a couple of
  // times a race, not a permanent escort.
  speedHeat: 1.7,
  hitHeat: 7,
  crashHeat: 5,
  copHitHeat: 20,
  heatDecay: 3.0,
  spawnBehind: 65,
  /**
   * How it actually works: the patrol shadows you and waits. Go down anywhere
   * near them and they pull up alongside and arrest you on the spot. Stay on
   * two wheels and they cannot touch you.
   */
  arrestRange: 14,
  /** Distance at which the HUD starts warning you they are right there. */
  dangerRange: 60,
  /** How long they will stand over a downed rider before cuffing them anyway. */
  arrestPatience: 4,
  /** Lead you must hold, for `escapeTime`, to lose them. */
  escapeDistance: 185,
  escapeTime: 2.6,
  giveUpKnockdowns: 3,
};

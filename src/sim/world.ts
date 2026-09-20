// The simulation. Owns the track, the field, traffic, pickups and the law.
//
// `step(dt, playerInput)` advances everything by a fixed timestep and returns a
// list of events. Nothing in here touches the DOM or Three.js, which is what
// makes the whole thing unit-testable under plain Node.

import { DIFFICULTY, RIVALS, POLICE, TRACK, CRASH, type DifficultyPreset } from './config';
import { clamp, makeRng } from './mathx';
import { Track } from './track';
import { createRacer, isRiding, RIDER_COLORS, knockDown } from './racer';
import { stepRacer, NEUTRAL_INPUT } from './physics';
import { resolveSwings, startAttack, canAttack } from './combat';
import { TrafficSystem, collideWithTraffic, collideRacers } from './traffic';
import { generatePickups, collectPickups } from './pickups';
import { aiInput, copParkInput, parkSpotBeside, createAiState, type AiWorldView } from './ai';
import {
  buildBiomes, buildRoadLayout, citySegments,
  type BiomeSegment, type CitySegment, type DividedSection,
} from './biomes';
import { generatePedestrians, stepPedestrians, type Crossing, type Pedestrian } from './pedestrians';
import { collideObstacles, generateObstacles, type Obstacle } from './obstacles';
import type {
  DifficultyKey,
  EndReason,
  Pickup,
  RacePhase,
  RaceResult,
  RaceState,
  Racer,
  RacerInput,
  Rng,
  SimEvent,
  StandingEntry,
} from './types';

export const COUNTDOWN_TIME = 3.6;

/**
 * The slowest a rider can be getting home at and still be considered to be
 * getting home, in m/s.
 *
 * It sets the backstop on how long the grid keeps being simulated after your
 * own race has ended. The field normally gets in long before it - whoever is
 * last is rarely more than half a minute back when the winner crosses, and
 * the simulation stops the moment they do - but the number has to be derived
 * from the race rather than picked, because it is the thing standing between a
 * rider still out on the road and the world being switched off underneath
 * them. At walking-pace-plus it allows a rider who crashes repeatedly the
 * whole length of the course, which is the worst case that is still racing.
 */
const POST_RACE_MIN_SPEED = 20;

/** Starting grid layout: four columns, rows 4.6 m apart, odd columns set back. */
const GRID_COLUMNS = 4;
const GRID_ROW_GAP = 4.6;
const GRID_STAGGER = 2.3;
/** Front row, third column - where the player lines up. */
const PLAYER_GRID_SLOT = 2;

export interface WorldOptions {
  seed?: number;
  difficulty?: DifficultyKey;
  riderName?: string;
}

export class World implements AiWorldView {
  readonly difficulty: DifficultyKey;
  readonly preset: DifficultyPreset;
  readonly seed: number;
  readonly rng: Rng;
  readonly raceDistance: number;
  readonly aggressionScale: number;
  readonly policeScale: number;

  readonly track: Track;
  readonly traffic: TrafficSystem;
  readonly pickups: Pickup[];
  readonly biomes: BiomeSegment[];
  readonly divided: DividedSection[];
  readonly citySegments: CitySegment[];
  readonly crossings: Crossing[];
  readonly pedestrians: Pedestrian[];
  /**
   * Trees and anything else solid beside the road.
   *
   * Generated from the seed on its own random stream, so every browser in a
   * room grows the identical wood whatever any of them managed to load - and
   * so the renderer can never shift them by drawing a different number of
   * random numbers than somebody else's renderer did.
   */
  readonly obstacles: Obstacle[];

  readonly player: Racer;

  /**
   * The rider this screen belongs to.
   *
   * Almost always `player` (racer 0). On a guest it is the racer in the seat
   * they took, because every browser builds the identical eight-rider field
   * and seat 0 belongs to the host. Getting this wrong pointed every guest's
   * camera at the host's bike, so two players watched one motorcycle.
   *
   * Only the camera, HUD and audio follow this. Everything the simulation
   * decides still revolves around `player`, which is what the host simulates
   * and what the snapshots overwrite.
   */
  localRacer: Racer;

  /**
   * Who the police are after and who the rivals pace themselves against.
   *
   * The same rider the screen belongs to. Offline that is racer 0; online the
   * host sits at the back of the grid, and before this the patrol chased a
   * bot while the rivals raced against one too.
   */
  get chased(): Racer {
    return this.localRacer;
  }
  readonly rivals: Racer[] = [];
  cop: Racer | null = null;
  readonly racers: Racer[];

  state: RaceState = 'countdown';
  /**
   * Whether this browser decides how the local rider's race ends.
   *
   * True offline and on the host. False on a guest, where crossing the line,
   * being beaten unconscious and being arrested are all the host's verdicts to
   * reach. A guest that decided for itself decided on a health bar a frame out
   * of date - which is how a guest who was merely knocked down ended up with
   * its own race quietly marked over, and the road stopping under it.
   */
  authority = true;
  countdown = COUNTDOWN_TIME;
  elapsed = 0;
  heat = 0;
  bustProgress = 0;
  /** Set when a patrol has reached you while you are down. */
  arrestPending = false;
  escapeTimer = 0;
  arrestTimer = 0;
  copsSeen = 0;
  result: RaceResult | null = null;
  standings: Racer[] = [];

  private lastLight = 4;
  /**
   * Whether the rest of the grid keeps racing once your own race has ended.
   *
   * Set when you finish - the standings behind the results screen are a live
   * race, not a freeze frame, and the riders you beat are still out there
   * earning their places - and set whenever anybody else is riding one of
   * these bikes from another browser, because their race is not over just
   * because yours is.
   */
  private followField = false;
  /** Seconds simulated since your own race ended, against POST_RACE_GRACE. */
  private postRaceTime = 0;
  /** Set once an input has arrived from another browser for any seat. */
  private sawRemotes = false;
  /**
   * Racer ids holding the throttle at the right moment.
   *
   * A set rather than a flag: every rider on the grid can nail the start, and
   * a remote rider's throttle arrives in `remoteInputs` exactly like the local
   * player's. Before this, only seat 0 could ever get the launch boost.
   */
  private holeshotArmed = new Set<number>();

  constructor({ seed = Date.now() & 0xffff, difficulty = 'normal', riderName = 'YOU' }: WorldOptions = {}) {
    const preset = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
    this.difficulty = difficulty;
    this.preset = preset;
    this.seed = seed;
    this.rng = makeRng(seed);
    this.raceDistance = preset.distance;
    this.aggressionScale = preset.aggression;
    this.policeScale = preset.police;

    // Biomes first: the track levels itself out along coast sections, so it
    // needs to know where they are before it bakes its elevation.
    const trackLength = this.raceDistance + TRACK.runout;
    this.biomes = buildBiomes(trackLength, this.rng);
    // Road layout next: a split that starts in a biome stretches that biome to
    // cover the whole thing, so this has to happen before the track bakes.
    this.divided = buildRoadLayout(trackLength, this.rng, this.biomes, {
      medianHalfWidth: TRACK.medianHalfWidth,
      forkHalfWidth: TRACK.forkHalfWidth,
      forkChance: TRACK.forkChance,
      medianLength: TRACK.medianLength,
      forkLength: TRACK.forkLength,
      gap: TRACK.medianGap,
      cityMargin: TRACK.splitBiomeMargin,
    });
    this.track = new Track({
      seed,
      length: trackLength,
      biomes: this.biomes,
      divided: this.divided,
    });
    this.traffic = new TrafficSystem(this.track, this.rng, { density: preset.traffic });
    this.pickups = generatePickups(this.track, this.rng, this.raceDistance);
    this.obstacles = generateObstacles(this.track, this.biomes, seed);
    this.citySegments = citySegments(this.biomes);
    const crowd = generatePedestrians(this.citySegments, this.rng, this.track);
    this.crossings = crowd.crossings;
    this.pedestrians = crowd.pedestrians;

    // --- the field ------------------------------------------------------
    // Colours are dealt from a shuffled palette rather than fixed per seat, so
    // the grid looks different every race. Shuffled with the world RNG, not
    // Math.random: every browser in a room builds this field from the same
    // seed, and riders wearing different colours on different screens would
    // make a mess of "the red one just knocked me off".
    const palette = [...RIDER_COLORS];
    for (let i = palette.length - 1; i > 0; i--) {
      const j = this.rng.int(0, i);
      [palette[i], palette[j]] = [palette[j]!, palette[i]!];
    }

    this.player = createRacer({
      id: 0,
      kind: 'player',
      name: riderName,
      color: palette[0]!,
      s: 0,
      lateral: TRACK.laneCentres[PLAYER_GRID_SLOT],
      speedScale: 1,
    });

    const names = [...RIVALS.names];
    for (let i = 0; i < RIVALS.count; i++) {
      const nameIndex = this.rng.int(0, names.length - 1);
      const [name] = names.splice(nameIndex, 1);
      const skill = this.rng.range(RIVALS.skill[0], RIVALS.skill[1]) * preset.rivalSkill;
      // Proper starting grid: four columns, staggered rows. The player holds
      // front-row column 2, so rivals skip that slot entirely.
      const slot = i < PLAYER_GRID_SLOT ? i : i + 1;
      const row = Math.floor(slot / GRID_COLUMNS);
      const column = slot % GRID_COLUMNS;
      const rival = createRacer({
        id: i + 1,
        kind: 'rival',
        name: name ?? `RIDER ${i + 1}`,
        color: palette[(i + 1) % palette.length]!,
        s: -(row * GRID_ROW_GAP + (column % 2) * GRID_STAGGER),
        lateral: TRACK.laneCentres[column],
        speedScale: skill,
        aggression: this.rng.range(RIVALS.aggression[0], RIVALS.aggression[1]),
      });
      rival.ai = createAiState(this.rng);
      this.rivals.push(rival);
    }

    // Racer 0 gets a brain too. Offline it never uses one - it is you - but
    // riders fill the grid from the back, so online somebody else holds the
    // local seat and racer 0 is just another bot. Without this it had no AI
    // state at all and simply ran flat out in a straight line.
    //
    // Created last on purpose: every RNG draw before this point builds the
    // track, the traffic and the rivals, and inserting a draw earlier would
    // change what every existing seed produces.
    this.player.ai = createAiState(this.rng);

    this.racers = [this.player, ...this.rivals];
    this.localRacer = this.player;
    this.traffic.prime(200);
    this.updateStandings();
  }

  get finishDistance(): number {
    return this.raceDistance;
  }

  get progress(): number {
    return clamp(this.localRacer.s / this.raceDistance, 0, 1);
  }

  /** Every bike currently on the road, cop included. */
  get field(): Racer[] {
    return this.cop ? [...this.racers, this.cop] : this.racers;
  }

  /**
   * Adopt the patrols the host says are out there.
   *
   * A guest never spawns police of its own - heat, pursuit and arrest are all
   * decided by the host - but it still has to draw them, and they are not
   * part of the eight-rider grid the seed builds. This creates a shell for
   * each id the host reports and drops the ones it no longer does.
   */
  adoptCops(ids: readonly number[]): Racer[] {
    if (ids.length === 0) {
      this.cop = null;
      return [];
    }
    // One patrol is all the rest of the sim is shaped for today; taking the
    // first keeps this honest rather than half-supporting more.
    const id = ids[0]!;
    if (!this.cop || this.cop.id !== id) {
      const cop = createRacer({
        id,
        kind: 'cop',
        name: 'HIGHWAY PATROL',
        color: 0x1c2b4a,
        s: this.localRacer.s,
        lateral: this.localRacer.lateral,
        speed: this.localRacer.speed,
      });
      cop.weapon = 'baton';
      cop.weaponTimer = Infinity;
      this.cop = cop;
    }
    return [this.cop];
  }

  get isOver(): boolean {
    return this.state === 'finished' || this.state === 'busted' || this.state === 'wasted';
  }

  /** Has this rider's race been decided, one way or another? */
  private isDone(r: Racer): boolean {
    if (r.finishTime != null || r.state === 'busted') return true;
    // Yours ends when it ends, however it ended: a rider who was wasted never
    // crosses the line, and waiting for them to would hold the whole grid open
    // until the backstop ran out.
    return this.isOver && r === this.localRacer;
  }

  /**
   * How long the grid keeps racing after your own race ends before we accept
   * that whoever is left is not coming home.
   */
  get postRaceGrace(): number {
    return this.raceDistance / POST_RACE_MIN_SPEED;
  }

  /** Is anybody still out on the road with something left to settle? */
  get fieldStillRacing(): boolean {
    if (this.postRaceTime > this.postRaceGrace) return false;
    return this.racers.some((r) => !this.isDone(r));
  }

  /**
   * Nothing left to simulate: your race is over and so is everybody else's.
   *
   * What the host stops broadcasting on, and what tells a rider watching the
   * board that the times on it are final rather than still moving.
   */
  get raceComplete(): boolean {
    return this.isOver && !this.fieldStillRacing;
  }

  /**
   * Is there a race going on for anyone at all?
   *
   * Not the same as "am I still in it". Online, the host's own race ending is
   * the most ordinary thing in the world - somebody has to finish first - and
   * the seven riders still out there must keep being able to throw a punch.
   */
  get inPlay(): boolean {
    return this.state === 'racing' || (this.isOver && this.fieldStillRacing);
  }

  /** Where the race as a whole has got to, for the riders watching it. */
  get phase(): RacePhase {
    if (this.state === 'countdown') return 'countdown';
    return this.raceComplete ? 'complete' : 'racing';
  }

  /**
   * The running order, as the results board prints it.
   *
   * `isPlayer` is the rider holding this screen, not racer 0 - online those
   * are different people, and marking racer 0 put the highlight on the host's
   * bike on every guest's board.
   */
  standingEntries(): StandingEntry[] {
    return [...this.standings]
      .sort((a, b) => a.place - b.place || b.s - a.s)
      .map((r) => ({
        name: r.name,
        place: r.place,
        time: r.finishTime,
        isPlayer: r === this.localRacer,
        s: r.s,
      }));
  }

  updateStandings(): Racer[] {
    const order = [...this.racers].sort((a, b) => {
      const aDone = a.finishTime != null;
      const bDone = b.finishTime != null;
      if (aDone && bDone) return (a.finishTime as number) - (b.finishTime as number);
      if (aDone) return -1;
      if (bDone) return 1;
      return b.s - a.s;
    });
    order.forEach((r, i) => {
      r.place = i + 1;
    });
    this.standings = order;
    return order;
  }

  // ---------------------------------------------------------------- police
  addHeat(amount: number): void {
    if (this.cop) return;
    this.heat = clamp(this.heat + amount * this.policeScale, 0, POLICE.heatMax);
  }

  spawnCop(): Racer {
    const cop = createRacer({
      id: 900 + this.copsSeen,
      kind: 'cop',
      name: 'HIGHWAY PATROL',
      color: 0x1c2b4a,
      s: Math.max(0, this.localRacer.s - POLICE.spawnBehind),
      lateral: this.localRacer.lateral,
      speed: Math.max(this.localRacer.speed, 28),
      speedScale: 1.07,
      aggression: 1,
    });
    cop.weapon = 'baton';
    cop.weaponTimer = Infinity;
    cop.ai = createAiState(this.rng);
    this.cop = cop;
    this.copsSeen += 1;
    this.bustProgress = 0;
    this.escapeTimer = 0;
    return cop;
  }

  private stepPolice(dt: number, events: SimEvent[]): void {
    const player = this.localRacer;

    if (!this.cop) {
      const over = player.speed - POLICE.speedThreshold;
      if (over > 0 && isRiding(player)) {
        const gain = (over / 20) * POLICE.speedHeat * this.policeScale;
        this.heat = clamp(this.heat + gain * dt, 0, POLICE.heatMax);
      } else {
        this.heat = Math.max(0, this.heat - POLICE.heatDecay * dt);
      }
      if (this.heat >= POLICE.heatMax) {
        const cop = this.spawnCop();
        this.heat = POLICE.heatMax * 0.55;
        events.push({ type: 'copSpawn', cop });
      }
      return;
    }

    const cop = this.cop;

    // Enough beatings and they back off.
    if (cop.knockdowns >= POLICE.giveUpKnockdowns) {
      events.push({ type: 'copGiveUp', cop, reason: 'beaten' });
      this.cop = null;
      this.heat = 0;
      this.arrestPending = false;
      this.arrestTimer = 0;
      return;
    }

    // Outrun them and they break off the pursuit.
    const lead = player.s - cop.s;
    if (lead > POLICE.escapeDistance) {
      this.escapeTimer += dt;
      if (this.escapeTimer >= POLICE.escapeTime) {
        events.push({ type: 'copGiveUp', cop, reason: 'outrun' });
        this.cop = null;
        this.heat = 0;
        return;
      }
    } else {
      this.escapeTimer = Math.max(0, this.escapeTimer - dt * 0.5);
    }

    // Go down with a patrol on you and it is over. They break off the chase,
    // pull in beside where you fell and wait; you get nicked the moment you
    // are back on the bike, or eventually anyway if you just lie there.
    const gap = Math.abs(cop.s - player.s);
    if (player.state === 'down' && isRiding(cop) && gap < POLICE.arrestRange) {
      this.arrestPending = true;
    }
    if (this.arrestPending) {
      // Cuffed either when you remount, or after they have stood over you long
      // enough - you cannot simply lie there and wait them out.
      this.arrestTimer += dt;
      const backAtTheBike = player.riderPhase === 'lifting' || player.riderPhase === 'mounting';
      if (player.state === 'ride' || backAtTheBike || this.arrestTimer > POLICE.arrestPatience) {
        player.state = 'busted';
        this.endRace('busted', events);
        return;
      }
    }

    // 0..1 for the HUD: how much trouble you are in right now.
    this.bustProgress = clamp(1 - gap / POLICE.dangerRange, 0, 1);
  }

  // ------------------------------------------------------------------ race
  private endRace(reason: EndReason, events: SimEvent[]): void {
    if (this.isOver) return;
    this.state = reason;
    this.postRaceTime = 0;
    // Finishing is the one ending that leaves something worth watching: the
    // riders you beat are still coming. Being arrested or beaten unconscious
    // is not, unless somebody else is riding one of these bikes for real.
    this.followField = reason === 'finished' || this.sawRemotes;
    this.updateStandings();
    this.result = {
      reason,
      place: this.localRacer.place,
      time: this.localRacer.finishTime ?? this.elapsed,
      distance: this.localRacer.s,
      raceDistance: this.raceDistance,
      topSpeed: this.localRacer.bestSpeed,
      takedowns: this.localRacer.hitsLanded,
      crashes: this.localRacer.knockdowns,
      standings: this.standingEntries(),
    };
    events.push({ type: 'raceEnd', reason, result: this.result });
  }

  /**
   * Apply a verdict reached somewhere else - the host's - to our own race.
   *
   * A guest does not decide its own ending, so this is how one arrives: the
   * host's snapshot says our rider crossed the line or was taken off it, and
   * the same result panel goes up as it would have offline. Returns the events
   * it raised so the caller can hand them to the HUD in the usual way.
   */
  concludeLocal(reason: EndReason, finishTime: number | null = null): SimEvent[] {
    const events: SimEvent[] = [];
    if (this.isOver) return events;
    if (reason === 'finished') {
      this.localRacer.state = 'finished';
      this.localRacer.finishTime = finishTime ?? this.localRacer.finishTime ?? this.elapsed;
    } else if (reason === 'busted') {
      this.localRacer.state = 'busted';
    }
    this.endRace(reason, events);
    return events;
  }

  /** Queue a player attack. Returns true if the swing started. */
  requestAttack(dir: number): boolean {
    if (this.state !== 'racing') return false;
    if (!canAttack(this.localRacer)) return false;
    return startAttack(this.localRacer, dir);
  }

  /**
   * Host only: a punch thrown by somebody else's browser.
   *
   * A swing is an event, not a held control, so it cannot ride in the input
   * map the way throttle and steering do - a held flag would start a fresh
   * swing every time the cooldown expired, off a single press. The host is
   * handed each press once and turns it into exactly one swing here.
   */
  requestAttackFor(racerId: number, dir: number): boolean {
    // Deliberately not `state === 'racing'`: that is the HOST's own race, and
    // when the host crossed the line first every other rider's punches stopped
    // landing for the rest of the race.
    if (!this.inPlay) return false;
    const racer = this.field.find((r) => r.id === racerId);
    if (!racer || !canAttack(racer)) return false;
    return startAttack(racer, dir);
  }

  /**
   * Advance the world one fixed step.
   *
   * `remoteInputs` drives named racers from outside the sim, keyed by
   * `Racer.id` so the key survives a trip over the network. Anything absent
   * from the map is ridden by the AI as usual, which is what makes a rider
   * swappable: supply an entry and a bot becomes a human, drop it and the
   * same racer is a bot again on the very next tick.
   */
  step(
    dt: number,
    playerInput: Readonly<RacerInput> = NEUTRAL_INPUT,
    remoteInputs?: ReadonlyMap<number, Readonly<RacerInput>>,
  ): SimEvent[] {
    const events: SimEvent[] = [];
    if (remoteInputs?.size) this.sawRemotes = true;

    if (this.isOver) {
      this.postRaceTime += dt;
      // Your race is over; theirs is not. The grid keeps being simulated in
      // full so the standings behind the results screen keep moving and, on a
      // host, so the riders still out on the road keep being sent a world to
      // ride in. Once everybody is home there is nothing left to work out and
      // the scene simply ticks over.
      if (!this.followField || !this.fieldStillRacing) {
        this.stepVisualsOnly(dt);
        return events;
      }
    }

    // Once your race is decided your hands come off the bars: it rolls out,
    // gets picked up, or sits where the patrol left it. The controls belong to
    // the results screen now.
    const localInput = this.isOver ? NEUTRAL_INPUT : playerInput;

    if (this.state === 'countdown') {
      this.countdown -= dt;
      const light = Math.ceil(this.countdown);
      if (light < this.lastLight) {
        this.lastLight = light;
        events.push({ type: 'countdown', value: Math.max(0, light) });
      }
      // Hold the throttle as the lights go out for a launch boost. Every
      // human on the grid gets the same chance, local or not.
      for (const r of this.field) {
        const input = r === this.localRacer ? localInput : remoteInputs?.get(r.id);
        if (!input) continue; // AI riders do not get a holeshot
        const onGas = (input.throttle ?? 0) > 0.5;
        if (this.countdown < 0.55 && onGas) this.holeshotArmed.add(r.id);
        else if (this.countdown >= 0.55 && onGas) this.holeshotArmed.delete(r.id); // jumped the start
      }

      if (this.countdown <= 0) {
        this.state = 'racing';
        for (const r of this.field) {
          if (!this.holeshotArmed.has(r.id)) continue;
          r.boostTimer = 1.8;
          // The event is the local player's cue; other riders just get the boost.
          if (r === this.localRacer) events.push({ type: 'holeshot' });
        }
        events.push({ type: 'go' });
      }
      return events;
    }

    this.elapsed += dt;
    const prevPlace = this.localRacer.place;

    // --- inputs ------------------------------------------------------------
    const field = this.field;
    const inputs = new Map<Racer, Readonly<RacerInput>>();
    inputs.set(this.localRacer, isRiding(this.localRacer) ? localInput : NEUTRAL_INPUT);
    for (const r of field) {
      if (r === this.localRacer) continue;
      // A patrol with you on the ground stops racing and pulls over.
      if (r === this.cop && this.arrestPending) {
        inputs.set(r, copParkInput(r, this.localRacer.s, parkSpotBeside(this.localRacer, this.track)));
        continue;
      }
      // Someone else riding this one takes their input off the wire. The AI
      // is skipped rather than run-and-discarded, so it does not plan on a
      // human's behalf while they are connected.
      const remote = remoteInputs?.get(r.id);
      inputs.set(r, remote ?? aiInput(r, this, dt));
    }

    // --- integrate ----------------------------------------------------------
    const ctx = { raceDistance: this.raceDistance, elapsed: this.elapsed };
    for (const r of field) {
      const evs = stepRacer(r, this.track, inputs.get(r) ?? NEUTRAL_INPUT, dt, ctx);
      for (const e of evs) {
        events.push(e);
        if (e.type === 'crash' && e.racer === this.localRacer) this.addHeat(POLICE.crashHeat);
      }
    }

    // --- interactions --------------------------------------------------------
    for (const e of resolveSwings(field)) {
      events.push(e);
      if (e.type === 'hit' && e.attacker === this.localRacer) {
        this.addHeat(e.victim.kind === 'cop' ? POLICE.copHitHeat : POLICE.hitHeat);
      }
    }
    // Everybody a person is riding: this screen's rider, plus any seat being
    // driven from another browser. They are the ones the road has to be busy
    // for - see `interested` in TrafficSystem.step.
    const ridden = field.filter(
      (r) => r === this.localRacer || remoteInputs?.has(r.id) === true,
    );
    this.traffic.step(
      dt, this.localRacer.s, this.elapsed, field, this.localRacer.speed, ridden,
    );
    events.push(...collideWithTraffic(field, this.traffic));
    events.push(...collideRacers(field));
    events.push(...collideObstacles(field, this.obstacles, this.localRacer.s));
    events.push(...collectPickups(field, this.pickups));
    events.push(...stepPedestrians(this.pedestrians, field, this.localRacer.s, dt, this.track));

    for (const e of events) {
      // Flattening a pedestrian is exactly the sort of thing that gets you
      // noticed.
      if (e.type === 'pedestrianHit' && e.racer === this.localRacer) this.addHeat(POLICE.hitHeat * 1.6);
    }

    // A patrol is only ever interested in you, so once your race is settled
    // there is nothing for them to decide. They are left on the road rather
    // than deleted: a police bike blinking out of the shot behind the results
    // screen looks like a bug, and standing there looks like the arrest it was.
    if (!this.isOver) this.stepPolice(dt, events);

    // --- outcomes -------------------------------------------------------------
    if (this.authority && !this.isOver && this.localRacer.health <= 0 && this.localRacer.state !== 'busted') {
      knockDown(this.localRacer, 1, CRASH.tumbleTime + CRASH.knockoutExtra);
      // If a patrol put you there - or is simply standing over you when you go
      // down - you are arrested rather than merely beaten. Checking proximity
      // here as well as in stepPolice keeps the outcome independent of which
      // one happens to land first on a given tick.
      const cop = this.cop;
      const copOnScene =
        cop != null && isRiding(cop) && Math.abs(cop.s - this.localRacer.s) < POLICE.arrestRange;
      if (this.arrestPending || copOnScene) {
        this.localRacer.state = 'busted';
        this.endRace('busted', events);
      } else {
        this.endRace('wasted', events);
      }
    }

    this.updateStandings();
    if (this.localRacer.place !== prevPlace && this.state === 'racing') {
      events.push({ type: 'placeChange', place: this.localRacer.place, from: prevPlace });
    }
    if (this.authority && this.localRacer.state === 'finished' && this.state === 'racing') {
      this.endRace('finished', events);
    }

    return events;
  }

  /** Cheap update used once the race is over so the scene keeps moving. */
  private stepVisualsOnly(dt: number): void {
    const ctx = { raceDistance: Infinity, elapsed: this.elapsed };
    for (const r of this.field) {
      const input: RacerInput =
        r.kind === 'player'
          ? { ...NEUTRAL_INPUT }
          : { throttle: 0.5, brake: 0, steer: 0, attackLeft: false, attackRight: false };
      stepRacer(r, this.track, input, dt, ctx);
    }
    this.traffic.step(dt, this.localRacer.s, this.elapsed);
  }
}

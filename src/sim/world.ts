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
import { aiInput, createAiState, type AiWorldView } from './ai';
import type {
  DifficultyKey,
  EndReason,
  Pickup,
  RaceResult,
  RaceState,
  Racer,
  RacerInput,
  Rng,
  SimEvent,
} from './types';

export const COUNTDOWN_TIME = 3.6;

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

  readonly track: Track;
  readonly traffic: TrafficSystem;
  readonly pickups: Pickup[];

  readonly player: Racer;
  readonly rivals: Racer[] = [];
  cop: Racer | null = null;
  readonly racers: Racer[];

  state: RaceState = 'countdown';
  countdown = COUNTDOWN_TIME;
  elapsed = 0;
  heat = 0;
  bustProgress = 0;
  escapeTimer = 0;
  copsSeen = 0;
  result: RaceResult | null = null;
  standings: Racer[] = [];

  private lastLight = 4;
  private holeshotArmed = false;

  constructor({ seed = Date.now() & 0xffff, difficulty = 'normal', riderName = 'YOU' }: WorldOptions = {}) {
    const preset = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
    this.difficulty = difficulty;
    this.preset = preset;
    this.seed = seed;
    this.rng = makeRng(seed);
    this.raceDistance = preset.distance;
    this.aggressionScale = preset.aggression;

    this.track = new Track({ seed, length: this.raceDistance + TRACK.runout });
    this.traffic = new TrafficSystem(this.track, this.rng, { density: preset.traffic });
    this.pickups = generatePickups(this.track, this.rng, this.raceDistance);

    // --- the field ------------------------------------------------------
    this.player = createRacer({
      id: 0,
      kind: 'player',
      name: riderName,
      color: RIDER_COLORS[0],
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
        color: RIDER_COLORS[(i + 1) % RIDER_COLORS.length],
        s: -(row * GRID_ROW_GAP + (column % 2) * GRID_STAGGER),
        lateral: TRACK.laneCentres[column],
        speedScale: skill,
        aggression: this.rng.range(RIVALS.aggression[0], RIVALS.aggression[1]),
      });
      rival.ai = createAiState(this.rng);
      this.rivals.push(rival);
    }

    this.racers = [this.player, ...this.rivals];
    this.traffic.prime(200);
    this.updateStandings();
  }

  get finishDistance(): number {
    return this.raceDistance;
  }

  get progress(): number {
    return clamp(this.player.s / this.raceDistance, 0, 1);
  }

  /** Every bike currently on the road, cop included. */
  get field(): Racer[] {
    return this.cop ? [...this.racers, this.cop] : this.racers;
  }

  get isOver(): boolean {
    return this.state === 'finished' || this.state === 'busted' || this.state === 'wasted';
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
    this.heat = clamp(this.heat + amount, 0, POLICE.heatMax);
  }

  spawnCop(): Racer {
    const cop = createRacer({
      id: 900 + this.copsSeen,
      kind: 'cop',
      name: 'HIGHWAY PATROL',
      color: 0x1c2b4a,
      s: Math.max(0, this.player.s - POLICE.spawnBehind),
      lateral: this.player.lateral,
      speed: Math.max(this.player.speed, 28),
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
    const player = this.player;

    if (!this.cop) {
      const over = player.speed - POLICE.speedThreshold;
      if (over > 0 && isRiding(player)) {
        this.heat = clamp(this.heat + (over / 20) * POLICE.speedHeat * dt, 0, POLICE.heatMax);
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

    // Pull alongside long enough and you are done.
    const alongside =
      isRiding(cop) &&
      isRiding(player) &&
      Math.abs(cop.s - player.s) < POLICE.bustRange &&
      Math.abs(cop.lateral - player.lateral) < POLICE.bustLateral;
    if (alongside) {
      this.bustProgress = clamp(this.bustProgress + dt, 0, POLICE.bustTime);
      if (this.bustProgress >= POLICE.bustTime) {
        player.state = 'busted';
        this.endRace('busted', events);
      }
    } else {
      this.bustProgress = Math.max(0, this.bustProgress - POLICE.bustDecay * dt);
    }
  }

  // ------------------------------------------------------------------ race
  private endRace(reason: EndReason, events: SimEvent[]): void {
    if (this.isOver) return;
    this.state = reason;
    this.updateStandings();
    this.result = {
      reason,
      place: this.player.place,
      time: this.player.finishTime ?? this.elapsed,
      distance: this.player.s,
      raceDistance: this.raceDistance,
      topSpeed: this.player.bestSpeed,
      takedowns: this.player.hitsLanded,
      crashes: this.player.knockdowns,
      standings: this.standings.map((r) => ({
        name: r.name,
        place: r.place,
        time: r.finishTime,
        isPlayer: r.kind === 'player',
        s: r.s,
      })),
    };
    events.push({ type: 'raceEnd', reason, result: this.result });
  }

  /** Queue a player attack. Returns true if the swing started. */
  requestAttack(dir: number): boolean {
    if (this.state !== 'racing') return false;
    if (!canAttack(this.player)) return false;
    return startAttack(this.player, dir);
  }

  step(dt: number, playerInput: Readonly<RacerInput> = NEUTRAL_INPUT): SimEvent[] {
    const events: SimEvent[] = [];
    if (this.isOver) {
      // Keep the world alive behind the results screen.
      this.stepVisualsOnly(dt);
      return events;
    }

    if (this.state === 'countdown') {
      this.countdown -= dt;
      const light = Math.ceil(this.countdown);
      if (light < this.lastLight) {
        this.lastLight = light;
        events.push({ type: 'countdown', value: Math.max(0, light) });
      }
      // Hold the throttle as the lights go out for a launch boost.
      const onGas = (playerInput.throttle ?? 0) > 0.5;
      if (this.countdown < 0.55 && onGas) this.holeshotArmed = true;
      else if (this.countdown >= 0.55 && onGas) this.holeshotArmed = false; // jumped the start

      if (this.countdown <= 0) {
        this.state = 'racing';
        if (this.holeshotArmed) {
          this.player.boostTimer = 1.8;
          events.push({ type: 'holeshot' });
        }
        events.push({ type: 'go' });
      }
      return events;
    }

    this.elapsed += dt;
    const prevPlace = this.player.place;

    // --- inputs ------------------------------------------------------------
    const field = this.field;
    const inputs = new Map<Racer, Readonly<RacerInput>>();
    inputs.set(this.player, isRiding(this.player) ? playerInput : NEUTRAL_INPUT);
    for (const r of field) {
      if (r === this.player) continue;
      inputs.set(r, aiInput(r, this, dt));
    }

    // --- integrate ----------------------------------------------------------
    const ctx = { raceDistance: this.raceDistance, elapsed: this.elapsed };
    for (const r of field) {
      const evs = stepRacer(r, this.track, inputs.get(r) ?? NEUTRAL_INPUT, dt, ctx);
      for (const e of evs) {
        events.push(e);
        if (e.type === 'crash' && e.racer === this.player) this.addHeat(POLICE.crashHeat);
      }
    }

    // --- interactions --------------------------------------------------------
    for (const e of resolveSwings(field)) {
      events.push(e);
      if (e.type === 'hit' && e.attacker === this.player) {
        this.addHeat(e.victim.kind === 'cop' ? POLICE.copHitHeat : POLICE.hitHeat);
      }
    }
    this.traffic.step(dt, this.player.s, this.elapsed);
    events.push(...collideWithTraffic(field, this.traffic));
    events.push(...collideRacers(field));
    events.push(...collectPickups(field, this.pickups));

    this.stepPolice(dt, events);

    // --- outcomes -------------------------------------------------------------
    if (this.player.health <= 0 && this.player.state !== 'busted') {
      knockDown(this.player, 1, CRASH.knockoutDownTime);
      this.endRace('wasted', events);
    }

    this.updateStandings();
    if (this.player.place !== prevPlace && this.state === 'racing') {
      events.push({ type: 'placeChange', place: this.player.place, from: prevPlace });
    }
    if (this.player.state === 'finished' && this.state === 'racing') {
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
    this.traffic.step(dt, this.player.s, this.elapsed);
  }
}

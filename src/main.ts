// Entry point. Owns the game loop and the transitions between menu, race and
// the end screens.

import './style.css';

import { World } from './sim/world';
import { GameView } from './render/view';
import { GameAudio } from './audio/audio';
import { InputManager, type AttackSide } from './input/input';
import { Hud } from './ui/hud';
import { Screens, type StartOptions } from './ui/screens';
import { isRiding } from './sim/racer';
import { type NetSession, connect, readConfig } from './net/session';
import { type JoinMode, type OnlineRace, goOnline } from './net/online';
import { GRID_SLOTS } from './net/lobby';
import { RIVALS } from './sim/config';
import { applyCars, applyPeds, applyRacers } from './net/snapshot';
import type { DifficultyKey, RacerInput, SimEvent } from './sim/types';

/** Simulation runs at a fixed rate; rendering runs as fast as the display. */
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;

const NEUTRAL: RacerInput = {
  throttle: 0, brake: 0, steer: 0, attackLeft: false, attackRight: false,
};

/**
 * Online is on by default.
 *
 * It was opt-in via `?online=1` while it was unproven, which mostly served to
 * hide it from anyone who just opened the site. `?offline=1` is the way out,
 * and it exists so the end-to-end tests that are not about multiplayer do not
 * open real rooms on the live database every time they run.
 */
function onlineRequested(): boolean {
  return !urlFlag('offline');
}

/** `?emulator=1` races against the local Firebase emulator instead of the real project. */
function emulatorRequested(): boolean {
  return urlFlag('emulator');
}

function urlFlag(name: string): boolean {
  try {
    return new URLSearchParams(window.location.search).get(name) === '1';
  } catch {
    return false;
  }
}

type Mode = 'boot' | 'menu' | 'lobby' | 'racing' | 'paused' | 'over';

/** Enough to tell, from outside, whether riders are actually talking. */
export interface OnlineStatus {
  lobbyId: string;
  seat: number;
  isHost: boolean;
  /** Rider names on the grid, by seat. */
  seats: Array<{ slot: number; name: string }>;
  /** Host: seats a human is currently riding. Guest: empty. */
  driven: number[];
  /** Guest: snapshots held for interpolation. Host: 0. */
  buffered: number;
}

/** Small surface used by the end-to-end tests to drive the game headlessly. */
export interface MotorushApi {
  mode(): Mode;
  world(): World | null;
  start(opts?: Partial<StartOptions> & { seed?: number }): void;
  restart(): void;
  quit(): void;
  pause(): void;
  resume(): void;
  /** Advance the simulation without waiting for real time to pass. */
  fastForward(seconds: number, input?: Partial<RacerInput>): void;
  ready(): boolean;
  /** What this browser's online session looks like, or null if racing offline. */
  online(): OnlineStatus | null;
  /** Dev builds only: the renderer, for profiling draw load from the console. */
  view?(): GameView | null;
}

declare global {
  interface Window {
    motorush?: MotorushApi;
  }
}

class Game {
  private world: World;
  private view: GameView | null = null;
  private readonly audio = new GameAudio();
  private readonly input = new InputManager();
  private readonly hud = new Hud();
  private readonly screens: Screens;

  private mode: Mode = 'boot';
  private accumulator = 0;
  private lastFrame = 0;
  private rafId = 0;
  private lastInput: RacerInput;
  private options: StartOptions = { riderName: 'YOU', difficulty: 'normal' };
  private netSession: NetSession | null = null;
  private online: OnlineRace | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.world = new World({ seed: Game.newSeed(), difficulty: 'normal' });
    this.lastInput = this.input.sample();
    this.screens = new Screens({
      onStart: (opts) => void this.startRace(opts),
      onOnline: (intent, opts) => void this.enterRoom(intent, opts),
      onLaunch: () => void this.launchRoom(),
      onLeaveRoom: () => void this.leaveRoom(),
      onResume: () => this.resume(),
      onRestart: () => void this.startRace(this.options),
      onQuit: () => this.quitToMenu(),
    });

    // Unlock audio on the very first interaction, whatever it is. Waiting for
    // the start button means a guest whose race begins on the host's flag -
    // not on a gesture of their own - never gets any sound at all.
    const unlock = (): void => {
      void this.audio.start();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('touchend', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('touchend', unlock);
    window.addEventListener('keydown', unlock);

    // Phones suspend the audio context when the tab goes away.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void this.audio.resume();
    });

    this.input.onPause = () => this.togglePause();
    this.input.onMute = () => this.toggleMute();

    document.getElementById('btn-mute')?.addEventListener('click', () => this.toggleMute());
    window.addEventListener('resize', () => this.view?.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'racing') this.pause();
    });
  }

  private static newSeed(): number {
    return (Math.random() * 0xffff) | 0;
  }

  // ------------------------------------------------------------------- boot
  async boot(): Promise<void> {
    this.screens.show('loading');
    try {
      this.view = await GameView.create(this.canvas, this.world);
    } catch (err) {
      console.error('[motorush] failed to start the renderer', err);
      this.screens.setLoadingText('WEBGL UNAVAILABLE — TRY ANOTHER BROWSER');
      return;
    }
    this.hud.enableTouch(this.input);
    this.mode = 'menu';
    this.screens.show('splash');
    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame(this.frame);

    // Sign in while the player is still reading the menu. Failure is fine:
    // no session simply means every race is against bots, offline.
    if (onlineRequested()) {
      this.netSession = await connect(
        readConfig(import.meta.env as unknown as Record<string, unknown>),
        emulatorRequested(),
      );
      this.screens.enableOnline(
        this.netSession !== null,
        'Online is unavailable right now. Races here are against bots.',
      );
    }
  }

  // ----------------------------------------------------------------- rooms
  /**
   * Take a seat and sit in the room until the owner starts.
   *
   * Nothing is simulated yet: the race itself does not begin until the flag
   * drops, which is the host writing `startedAt` and everyone seeing it.
   */
  private async enterRoom(
    intent: 'quick' | 'create' | 'join',
    opts: StartOptions & { code?: string },
  ): Promise<void> {
    if (!this.netSession) return;
    this.options = { riderName: opts.riderName, difficulty: opts.difficulty };

    // Audio has to be kicked off from a user gesture; this is that moment.
    void this.audio.start();
    this.screens.setOnlineNote('');
    this.screens.show('loading');
    this.screens.setLoadingText(intent === 'join' ? 'FINDING ROOM' : 'OPENING ROOM');

    await this.online?.close().catch(() => {});
    this.online = null;

    const mode: JoinMode =
      intent === 'create' ? { kind: 'create' }
      : intent === 'join' ? { kind: 'code', code: opts.code ?? '' }
      : { kind: 'quick' };

    const online = await goOnline(this.netSession, opts.riderName, { mode });
    if (!online) {
      this.screens.show('splash');
      this.screens.setOnlineNote(
        intent === 'join'
          ? 'No room with that code, or it is full.'
          : 'Could not reach the server. Race offline instead.',
      );
      return;
    }

    this.online = online;
    this.mode = 'lobby';
    online.onRoom((room) => {
      if (!room) {
        // The owner closed the tab and took the room with them.
        void this.leaveRoom('The room owner left.');
        return;
      }
      if (room.started) {
        // Already racing: somebody took a seat or gave one up mid-race, so the
        // names on the bikes need to keep up.
        if (this.mode === 'racing' || this.mode === 'paused') {
          this.applySeatNames();
          return;
        }
        void this.beginOnlineRace();
        return;
      }
      if (this.mode === 'lobby') this.drawRoom();
    });
    this.drawRoom();
  }

  /**
   * Put the riders' own names on the bikes they are riding.
   *
   * Every browser builds the same eight-rider field from the seed, so seats
   * start out wearing invented rival names - and on a guest, racer 0 is named
   * after *them* rather than after the host. Whoever is actually in a seat
   * owns that name; the seats nobody took keep theirs, because those are bots.
   */
  private applySeatNames(): void {
    const online = this.online;
    if (!online) return;

    const taken = new Map(online.seats().map((s) => [s.slot, s.name]));
    const humans = new Set(taken.values());
    // Names no human is using, for the seats that are still bots.
    const spare = RIVALS.names.filter((n) => !humans.has(n));
    let nextSpare = 0;

    for (const racer of this.world.racers) {
      const seated = taken.get(racer.id);
      if (seated !== undefined) {
        racer.name = seated;
        continue;
      }
      // World names racer 0 after whoever is playing, but riders fill the
      // grid from the back - so on every screen racer 0 was a bot wearing its
      // own player's name, and the grid showed two of them.
      if (humans.has(racer.name)) {
        racer.name = spare[nextSpare % spare.length] ?? racer.name;
        nextSpare++;
      }
    }
  }

  private drawRoom(): void {
    const online = this.online;
    if (!online) return;
    this.screens.showLobby({
      code: online.code,
      youAreHost: online.isHost,
      gridSize: GRID_SLOTS,
      riders: online.seats().map((s) => ({
        slot: s.slot,
        name: s.name,
        isYou: s.slot === online.seat,
        // Riders fill the grid from the back, so the owner is no longer
        // whoever is in seat 0 - they are simply the first one who turned up.
        isHost: s.uid === online.hostUid,
      })),
    });
  }

  /** Owner pressed start. Everyone else finds out by watching the room. */
  private async launchRoom(): Promise<void> {
    if (!this.online?.isHost) return;
    await this.online.start();
  }

  private async leaveRoom(note = ''): Promise<void> {
    await this.online?.close().catch(() => {});
    this.online = null;
    this.mode = 'menu';
    this.screens.show('splash');
    this.screens.setOnlineNote(note);
  }

  /** The flag dropped. Build the world on the room's seed and go. */
  private async beginOnlineRace(): Promise<void> {
    if (this.mode === 'racing' || !this.online) return;
    await this.startRace({ ...this.options, seed: this.online.seed }, true);
  }

  // ------------------------------------------------------------ transitions
  async startRace(
    opts: Partial<StartOptions> & { seed?: number } = {},
    keepRoom = false,
  ): Promise<void> {
    this.options = {
      riderName: opts.riderName ?? this.options.riderName,
      difficulty: (opts.difficulty ?? this.options.difficulty) as DifficultyKey,
    };
    // Audio has to be kicked off from a user gesture; this is that moment.
    void this.audio.start();

    this.screens.show('loading');
    this.hud.setVisible(false);
    this.hud.clearTransient();

    // Let the loading screen paint before the (synchronous) world rebuild.
    await new Promise((r) => requestAnimationFrame(r));

    // An online race keeps the seat it already holds; an offline one gives up
    // whatever room it was in. Joining now would race the flag that started us.
    if (!keepRoom) {
      await this.online?.close().catch(() => {});
      this.online = null;
    }

    this.world = new World({
      // Every rider in a room must rebuild the identical track, so the seed
      // comes from the room rather than from this browser.
      seed: this.online?.seed ?? opts.seed ?? Game.newSeed(),
      difficulty: this.options.difficulty,
      riderName: this.options.riderName,
    });
    // A guest took a seat other than 0, and that is the bike their camera and
    // HUD belong to. Set before the renderer is built so it never shows a
    // frame following somebody else's rider.
    const seat = this.online?.seat ?? 0;
    this.world.localRacer = this.world.racers[seat] ?? this.world.player;
    this.applySeatNames();

    this.view?.rebuild(this.world);

    this.accumulator = 0;
    this.lastFrame = performance.now();
    this.mode = 'racing';
    this.screens.hideAll();
    this.hud.setVisible(true);
  }

  private onlineStatus(): OnlineStatus | null {
    const online = this.online;
    if (!online) return null;
    const nowMs = performance.now();
    return {
      lobbyId: online.lobbyId,
      seat: online.seat,
      isHost: online.isHost,
      seats: online.seats().map((s) => ({ slot: s.slot, name: s.name })),
      driven: [...online.inputs(nowMs).keys()].sort(),
      buffered: online.buffered(),
    };
  }

  private togglePause(): void {
    if (this.mode === 'racing') this.pause();
    else if (this.mode === 'paused') this.resume();
  }

  pause(): void {
    if (this.mode !== 'racing') return;
    this.mode = 'paused';
    this.screens.show('pause');
  }

  resume(): void {
    if (this.mode !== 'paused') return;
    this.mode = 'racing';
    this.lastFrame = performance.now();
    this.accumulator = 0;
    this.screens.hideAll();
  }

  quitToMenu(): void {
    void this.online?.close().catch(() => {});
    this.online = null;
    this.mode = 'menu';
    this.hud.setVisible(false);
    this.hud.clearTransient();
    this.screens.show('splash');
  }

  private toggleMute(): void {
    const muted = this.audio.toggleMute();
    const btn = document.getElementById('btn-mute');
    if (btn) btn.textContent = muted ? '🔇' : '🔊';
  }

  // ------------------------------------------------------------------- loop
  private readonly frame = (now: number): void => {
    this.rafId = requestAnimationFrame(this.frame);
    const dt = Math.min((now - this.lastFrame) / 1000, 0.25);
    this.lastFrame = now;

    const input = this.input.sample();
    this.lastInput = input;

    if (this.mode === 'racing') {
      this.stepSimulation(dt, input, now);
    } else if (this.mode === 'menu' || this.mode === 'over') {
      // Keep the scene alive behind the menus and end screens.
      this.world.step(dt, { throttle: 0, brake: 0, steer: 0, attackLeft: false, attackRight: false });
    }

    if (this.mode !== 'paused') {
      this.view?.render(dt, input);
    }
    if (this.mode === 'racing') {
      this.hud.update(this.world, dt);
    }

    const cop = this.world.cop;
    const me = this.world.localRacer;
    this.audio.update(
      me.speed,
      input.throttle,
      isRiding(me),
      cop ? Math.abs(me.s - cop.s) : null,
    );
  };

  private stepSimulation(dt: number, input: RacerInput, nowMs: number): void {
    if (this.online && !this.online.isHost) {
      this.stepAsGuest(dt, input, nowMs);
      return;
    }

    this.queueAttacks();

    // Offline this is empty, so the AI rides every bike exactly as before.
    const remote = this.online?.inputs(nowMs);

    this.accumulator += dt;
    let steps = 0;
    const events: SimEvent[] = [];
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      events.push(...this.world.step(FIXED_DT, input, remote));
      this.accumulator -= FIXED_DT;
      steps++;
    }
    // If the tab stalled, drop the backlog rather than fast-forwarding wildly.
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;

    this.online?.broadcast({
      racers: this.world.racers,
      cars: this.world.traffic.cars,
      peds: this.world.pedestrians,
      aroundS: this.world.player.s,
      time: this.world.elapsed,
      race: this.world.state,
      countdown: this.world.countdown,
    }, nowMs);

    // Shut the door when the race is over, not when it starts.
    //
    // Closing at lights-out seemed right and was badly wrong: the countdown is
    // 3.6 seconds, so in practice nobody could ever join anybody. Staying open
    // is also the whole point of the design - a rider who turns up mid-race
    // takes over a bot at that bot's position on the road, already up to
    // speed, rather than appearing at the start line.
    if (this.world.isOver) void this.online?.closeLobby();

    if (events.length) this.dispatch(events);
  }

  /**
   * A guest does not decide anything.
   *
   * It sends what it is holding and draws what the host sends back. The local
   * world is still stepped, but only to keep traffic, pedestrians and scenery
   * moving - every rider is then overwritten with the host's version, which is
   * the only one that counts.
   */
  private stepAsGuest(dt: number, input: RacerInput, nowMs: number): void {
    const online = this.online!;
    online.sendInput(input, nowMs);

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.world.step(FIXED_DT, NEUTRAL);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;

    const frame = online.sample(nowMs);
    if (!frame) return;

    applyRacers(this.world.racers, frame.racers);
    applyCars(this.world.traffic.cars, frame.cars);
    applyPeds(this.world.pedestrians, frame.peds);

    // The host owns the race clock too. Without this a guest that joined
    // mid-countdown runs its own lights, and one that joined late never sees
    // the race end at all - its local rider is never simulated, so it would
    // sit on the start line for ever.
    this.world.countdown = frame.countdown;
    if (frame.race !== this.world.state) {
      this.world.state = frame.race;
      if (frame.race === 'finished' || frame.race === 'busted' || frame.race === 'wasted') {
        this.showRemoteResult(frame.race);
      }
    }
  }

  /** A guest's race ends when the host says it does. */
  private showRemoteResult(reason: 'finished' | 'busted' | 'wasted'): void {
    if (this.mode === 'over') return;
    this.mode = 'over';
    this.hud.setVisible(false);
    const player = this.world.player;
    // Built the same way World.endRace builds it, from the state the host has
    // already put on our grid - the guest never runs endRace itself.
    this.screens.showResult({
      reason,
      place: player.place,
      time: player.finishTime ?? this.world.elapsed,
      distance: player.s,
      raceDistance: this.world.raceDistance,
      topSpeed: player.bestSpeed,
      takedowns: player.hitsLanded,
      crashes: player.knockdowns,
      standings: this.world.standings.map((r) => ({
        name: r.name,
        place: r.place,
        time: r.finishTime,
        isPlayer: r.kind === 'player',
        s: r.s,
      })),
    });
  }

  /** Turn queued attack presses into swings, resolving "auto" to a side. */
  private queueAttacks(): void {
    for (const side of this.input.consumeAttacks()) {
      const dir = side === 0 ? this.nearestSide() : side;
      this.world.requestAttack(dir);
    }
  }

  private nearestSide(): AttackSide {
    const p = this.world.localRacer;
    let best: number | null = null;
    let bestDist = Infinity;
    for (const r of this.world.field) {
      if (r === p || !isRiding(r)) continue;
      const ds = Math.abs(r.s - p.s);
      if (ds > 4) continue;
      const dx = r.lateral - p.lateral;
      if (Math.abs(dx) > 4) continue;
      const d = ds + Math.abs(dx);
      if (d < bestDist) {
        bestDist = d;
        best = dx;
      }
    }
    if (best == null) return 1;
    return best >= 0 ? 1 : -1;
  }

  private dispatch(events: SimEvent[]): void {
    this.view?.handleEvents(events);
    this.hud.handleEvents(events, this.world);
    this.audio.handleEvents(events, this.world.player.id);

    for (const e of events) {
      if (e.type === 'raceEnd') {
        this.mode = 'over';
        this.hud.setVisible(false);
        this.screens.showResult(e.result);
      }
    }
  }

  // ------------------------------------------------------------- test hooks
  api(): MotorushApi {
    return {
      mode: () => this.mode,
      world: () => this.world,
      online: () => this.onlineStatus(),
      start: (opts) => void this.startRace(opts ?? {}),
      restart: () => void this.startRace(this.options),
      quit: () => this.quitToMenu(),
      pause: () => this.pause(),
      resume: () => this.resume(),
      ready: () => this.view !== null,
      // Dev-only handle on the renderer, for profiling draw load from the
      // console. Stripped from production builds.
      ...(import.meta.env.DEV ? { view: () => this.view } : {}),
      fastForward: (seconds, input) => {
        const full: RacerInput = {
          throttle: 1, brake: 0, steer: 0, attackLeft: false, attackRight: false, ...input,
        };
        const steps = Math.floor(seconds / FIXED_DT);
        for (let i = 0; i < steps; i++) {
          const events = this.world.step(FIXED_DT, full);
          if (events.length) this.dispatch(events);
          if (this.mode !== 'racing') break;
        }
      },
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.input.dispose();
    this.audio.dispose();
    this.view?.dispose();
  }
}

const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
if (canvas) {
  const game = new Game(canvas);
  window.motorush = game.api();
  void game.boot();
}

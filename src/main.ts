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
import type { DifficultyKey, RacerInput, SimEvent } from './sim/types';

/** Simulation runs at a fixed rate; rendering runs as fast as the display. */
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;

type Mode = 'boot' | 'menu' | 'racing' | 'paused' | 'over';

/** Small surface used by the end-to-end tests to drive the game headlessly. */
export interface RoadbrushApi {
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
}

declare global {
  interface Window {
    roadbrush?: RoadbrushApi;
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

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.world = new World({ seed: Game.newSeed(), difficulty: 'normal' });
    this.lastInput = this.input.sample();
    this.screens = new Screens({
      onStart: (opts) => void this.startRace(opts),
      onResume: () => this.resume(),
      onRestart: () => void this.startRace(this.options),
      onQuit: () => this.quitToMenu(),
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
      console.error('[roadbrush] failed to start the renderer', err);
      this.screens.setLoadingText('WEBGL UNAVAILABLE — TRY ANOTHER BROWSER');
      return;
    }
    this.hud.enableTouch(this.input);
    this.mode = 'menu';
    this.screens.show('splash');
    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------ transitions
  async startRace(opts: Partial<StartOptions> & { seed?: number } = {}): Promise<void> {
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

    this.world = new World({
      seed: opts.seed ?? Game.newSeed(),
      difficulty: this.options.difficulty,
      riderName: this.options.riderName,
    });
    this.view?.rebuild(this.world);

    this.accumulator = 0;
    this.lastFrame = performance.now();
    this.mode = 'racing';
    this.screens.hideAll();
    this.hud.setVisible(true);
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
      this.stepSimulation(dt, input);
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
    this.audio.update(
      this.world.player.speed,
      input.throttle,
      isRiding(this.world.player),
      cop ? Math.abs(this.world.player.s - cop.s) : null,
    );
  };

  private stepSimulation(dt: number, input: RacerInput): void {
    this.queueAttacks();

    this.accumulator += dt;
    let steps = 0;
    const events: SimEvent[] = [];
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      events.push(...this.world.step(FIXED_DT, input));
      this.accumulator -= FIXED_DT;
      steps++;
    }
    // If the tab stalled, drop the backlog rather than fast-forwarding wildly.
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;

    if (events.length) this.dispatch(events);
  }

  /** Turn queued attack presses into swings, resolving "auto" to a side. */
  private queueAttacks(): void {
    for (const side of this.input.consumeAttacks()) {
      const dir = side === 0 ? this.nearestSide() : side;
      this.world.requestAttack(dir);
    }
  }

  private nearestSide(): AttackSide {
    const p = this.world.player;
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
  api(): RoadbrushApi {
    return {
      mode: () => this.mode,
      world: () => this.world,
      start: (opts) => void this.startRace(opts ?? {}),
      restart: () => void this.startRace(this.options),
      quit: () => this.quitToMenu(),
      pause: () => this.pause(),
      resume: () => this.resume(),
      ready: () => this.view !== null,
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
  window.roadbrush = game.api();
  void game.boot();
}

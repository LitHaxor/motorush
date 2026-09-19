// Entry point. Owns the game loop and the transitions between menu, race and
// the end screens.

import './style.css';

import { World } from './sim/world';
import { GameView } from './render/view';
import { GameAudio } from './audio/audio';
import { InputManager, type AttackSide } from './input/input';
import { Hud } from './ui/hud';
import { Screens, type LinkTrouble, type StartOptions } from './ui/screens';
import { isRiding } from './sim/racer';
import { type NetSession, connect, readConfig } from './net/session';
import { type JoinMode, type OnlineRace, goOnline } from './net/online';
import { GRID_SLOTS } from './net/lobby';
import { RIVALS } from './sim/config';
import { applyCars, applyPeds, applyRacers, reconcileLocalRacer } from './net/snapshot';
import type { RacerSnapshot } from './net/protocol';
import type { DifficultyKey, Racer, RacerInput, SimEvent } from './sim/types';

/** Simulation runs at a fixed rate; rendering runs as fast as the display. */
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;

const NEUTRAL: RacerInput = {
  throttle: 0, brake: 0, steer: 0, attackLeft: false, attackRight: false,
};

/**
 * Auto-recovery, in three stages.
 *
 * A guest draws the host's world, so when the host goes quiet the guest used
 * to freeze mid-race with the controls apparently dead - there was no stage
 * two. There is now, and it is deliberately generous, because most silences
 * are a lift, a tunnel or a phone switching to another mast, and they end.
 *
 * 1. Under HOLD, nothing is said. This is ordinary jitter on a long link and
 *    the interpolation buffer is there precisely to cover it.
 * 2. Past HOLD, the guest stops waiting and rides its own simulation - the
 *    bike answers the controls immediately, the bots take the other bikes
 *    back, and the HUD says LOCAL CONTROL. If the host comes back, its frames
 *    are blended in and nobody had to do anything.
 * 3. Past PATIENCE, the race is very probably not coming back, so it is time
 *    to say so and offer the way out rather than pretending.
 */
const GUEST_HOLD_MS = 600;
const GUEST_PATIENCE_MS = 3000;
/** How long the reconnect screen keeps hoping before calling it lost. */
const GUEST_GIVE_UP_MS = 12000;

/**
 * The backstop.
 *
 * Everything above handles a silence we understand. This handles the ones we
 * do not: if the race stops advancing at all - for any reason, including one
 * that has not been thought of here - say so and put two working buttons on
 * screen. Being stuck with no way out is the worst thing this game can do to
 * somebody, and it is not allowed to depend on having diagnosed the cause.
 */
const WATCHDOG_MS = 4000;

/** The least time between two announcements about the link. */
const LINK_TOAST_GAP_MS = 6000;

/** How many times sign-in retries itself in the background before resting. */
const SIGN_IN_TRIES = 5;

const OFFLINE_NOTE = 'Could not reach the server. Try again, or race the bots.';

/**
 * How long any one step of getting online may take before we give up on it.
 *
 * Not a nicety. A request to a database on a phone that has just lost signal
 * can hang rather than fail, and the loading screen carries no buttons - so
 * without this the player sits watching a spinner with nothing to press,
 * which is the same dead end as a frozen race by another route.
 */
const ONLINE_STEP_TIMEOUT_MS = 15_000;

/** Resolve to null rather than hanging for ever. */
function withTimeout<T>(work: Promise<T>, ms = ONLINE_STEP_TIMEOUT_MS): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), ms);
    void work.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      () => { window.clearTimeout(timer); resolve(null); },
    );
  });
}

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
  /** This frame's merged input, so a test can see what a touch button did. */
  input(): RacerInput;
  /** Why the connection screen is up, if it is. Null when all is well. */
  link(): LinkTrouble | null;
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
  /** The sign-in currently in flight, so two callers never race each other. */
  private signInAttempt: Promise<NetSession | null> | null = null;
  private online: OnlineRace | null = null;
  /**
   * Punches thrown but not yet sent.
   *
   * Input frames go out thirty times a second and the screen draws sixty, so
   * a punch pressed on an unsent frame would simply vanish. It waits here
   * until a frame actually leaves.
   */
  private pendingSwings: AttackSide[] = [];
  /** Set while a guest is riding its own simulation because the host is quiet. */
  private localControl = false;
  /** When the link last got a word in edgeways, so it cannot nag. */
  private lastLinkToastMs = 0;
  /** Set once the player has chosen to finish the race without the room. */
  private wentSolo = false;
  /** Why the connection screen is up, or null when it is not. */
  private linkTrouble: LinkTrouble | null = null;
  /** Watchdog: how far the race had got, and when we last saw it move. */
  private lastProgress = 0;
  private lastProgressAtMs = 0;
  /** Frames that threw, one after another. A few is a blip; a stream is a jam. */
  private frameFaults = 0;
  /**
   * Which race we are in, as the room stamped its start.
   *
   * A room can race more than once. Without this a rider sitting in the lobby
   * after a race would be thrown straight back into the one they had just
   * ridden, because the room still said it had started.
   */
  private racedAt: number | null = null;
  /**
   * Which race the world we are holding was built for.
   *
   * Set when the rebuild finishes, which is the moment the world stops being
   * the one that was idling behind the menu and becomes the one everybody is
   * racing in. The host must not put a single frame of the former on the wire:
   * that world has been running since the page loaded, so its riders are
   * kilometres up a road nobody has started yet - and a guest handed one of
   * those frames was thrown past the finish line and handed a result before
   * the lights had even gone out.
   */
  private worldRound: number | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.world = new World({ seed: Game.newSeed(), difficulty: 'normal' });
    this.lastInput = this.input.sample();
    this.screens = new Screens({
      onStart: (opts) => void this.startRace(opts),
      onOnline: (intent, opts) => void this.enterRoom(intent, opts),
      onLaunch: () => void this.launchRoom(),
      onLeaveRoom: () => void this.leaveRoom(),
      onBackToLobby: () => this.backToLobby(),
      onResume: () => this.resume(),
      onRestart: () => void this.startRace(this.options),
      onQuit: () => this.quitToMenu(),
      onContinueOffline: () => this.continueOffline(),
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
    // The only way out of a race on a phone: there is no Escape key to press.
    document.getElementById('btn-pause')?.addEventListener('click', () => this.togglePause());
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

    // Sign in while the player is still reading the menu. Failure is not
    // final: the doors open either way and the next attempt is made when
    // somebody reaches for one, or on the retry below.
    if (onlineRequested()) {
      const session = await this.signIn();
      this.screens.enableOnline(session !== null, OFFLINE_NOTE);
      if (!session) this.retrySignIn();
    }
  }

  /**
   * Get a signed-in session, making one if we do not have it.
   *
   * Sign-in is a network call on a phone that may have been in a lift when
   * the page loaded, so "it failed once" must never harden into "online is
   * off until you reload". Concurrent callers share the one attempt.
   */
  private async signIn(): Promise<NetSession | null> {
    if (this.netSession) return this.netSession;
    this.signInAttempt ??= connect(
      readConfig(import.meta.env as unknown as Record<string, unknown>),
      emulatorRequested(),
    ).finally(() => {
      this.signInAttempt = null;
    });
    this.netSession = await this.signInAttempt;
    return this.netSession;
  }

  /**
   * Keep trying quietly in the background, backing off as it goes.
   *
   * The player is not told about any of this - they are reading the menu.
   * They are told when it works, by the warning under the buttons going away.
   */
  private retrySignIn(attempt = 1): void {
    if (this.netSession || attempt > SIGN_IN_TRIES) return;
    const waitMs = Math.min(30_000, 2000 * 2 ** (attempt - 1));
    window.setTimeout(() => {
      void this.signIn().then((session) => {
        if (session) {
          this.screens.enableOnline(true);
          return;
        }
        this.retrySignIn(attempt + 1);
      });
    }, waitMs);
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
    this.options = { riderName: opts.riderName, difficulty: opts.difficulty };

    // Audio has to be kicked off from a user gesture; this is that moment.
    void this.audio.start();
    this.screens.setOnlineNote('');
    this.screens.show('loading');
    this.screens.setLoadingText(intent === 'join' ? 'FINDING ROOM' : 'OPENING ROOM');

    // Pressing the button is itself another go at signing in. Being told "no"
    // once while the page was loading is not a reason to refuse for ever, and
    // a button that silently does nothing is the worst of both.
    if (!this.netSession) this.screens.setLoadingText('CONNECTING');
    const session = await withTimeout(this.signIn());
    if (!session) {
      this.screens.show('splash');
      this.screens.enableOnline(false, OFFLINE_NOTE);
      this.retrySignIn();
      return;
    }
    this.screens.enableOnline(true);

    await this.online?.close().catch(() => {});
    this.online = null;

    const mode: JoinMode =
      intent === 'create' ? { kind: 'create' }
      : intent === 'join' ? { kind: 'code', code: opts.code ?? '' }
      : { kind: 'quick' };

    const askedAt = performance.now();
    const online = await withTimeout(goOnline(session, opts.riderName, { mode }));
    if (!online) {
      // "Nobody is there" and "we never heard back" are different problems
      // and want different things from the player, so they are not told the
      // same thing. The doors stay open either way.
      const timedOut = performance.now() - askedAt >= ONLINE_STEP_TIMEOUT_MS;
      this.screens.show('splash');
      this.screens.setOnlineNote(
        timedOut
          ? 'The server did not answer. Try again, or race the bots.'
          : intent === 'join'
            ? 'No room with that code, or it is full.'
            : 'Could not reach the server. Race offline instead.',
      );
      return;
    }

    this.online = online;
    this.mode = 'lobby';
    online.onRoom((room) => {
      if (!room) {
        // The owner closed the tab and took the room with them. Mid-race that
        // is not a reason to throw the race away - the world is already being
        // simulated here, so it can simply carry on against bots.
        if (this.mode === 'racing' || this.mode === 'paused') {
          this.linkTrouble = 'host-left';
          this.setLocalControl(true);
          this.screens.showLink({ kind: 'host-left', pingMs: this.online?.ping(performance.now()) ?? null });
          return;
        }
        void this.leaveRoom('The room owner left.');
        return;
      }
      if (room.started) {
        // The race we are already in - or have already ridden and stepped out
        // of. Somebody taking a seat or giving one up only means the names on
        // the bikes need to keep up.
        if (room.startedAt === this.racedAt) {
          if (this.mode !== 'lobby' && this.mode !== 'menu') this.applySeatNames();
          return;
        }
        void this.beginOnlineRace(room.startedAt);
        return;
      }
      // Flag down: the room is a waiting room again, and the owner can drop it
      // a second time. Anyone already back in the lobby wants to see who is
      // still here for the next one.
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
    // Every name already spoken for. It starts as the humans' and grows as the
    // bots are walked, because a name that was merely free of humans could
    // still be worn by another bot - which is how one grid ended up with two
    // VIPERs on it, and a results board you had to count rows to find yourself
    // on.
    const inUse = new Set(taken.values());
    const bots: Racer[] = [];

    for (const racer of this.world.racers) {
      const seated = taken.get(racer.id);
      if (seated !== undefined) {
        racer.name = seated;
        continue;
      }
      bots.push(racer);
    }

    for (const bot of bots) {
      // World names racer 0 after whoever is playing, but riders fill the grid
      // from the back - so on every screen racer 0 was a bot wearing its own
      // player's name, and the grid showed two of them.
      if (!inUse.has(bot.name)) {
        inUse.add(bot.name);
        continue;
      }
      bot.name = RIVALS.names.find((n) => !inUse.has(n)) ?? `RIDER ${bot.id + 1}`;
      inUse.add(bot.name);
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

  /**
   * Owner pressed start. Everyone else finds out by watching the room.
   *
   * A room that has already raced is put back to the lobby first, on a fresh
   * seed - so the rematch is a new road rather than the same seven kilometres
   * again, and so every rider sees the flag drop as a new race rather than as
   * the one they have just ridden.
   */
  private async launchRoom(): Promise<void> {
    const online = this.online;
    if (!online?.isHost) return;
    if (online.startedAt() !== null) await online.rematch();
    await online.start();
  }

  /**
   * Step out of the race, but not out of the room.
   *
   * The way back to the grid when your own race is run: the seat stays yours,
   * the names stay on the board, and the owner can start another one. On the
   * host the world carries on turning behind this screen, because the riders
   * still out on the road are riding in it - see `servesOthers`.
   */
  private backToLobby(): void {
    if (!this.online) {
      this.quitToMenu();
      return;
    }
    this.mode = 'lobby';
    this.linkTrouble = null;
    this.localControl = false;
    this.hud.setVisible(false);
    this.hud.clearTransient();
    this.hud.setLink(null);
    this.drawRoom();
  }

  private async leaveRoom(note = ''): Promise<void> {
    await this.online?.close().catch(() => {});
    this.online = null;
    this.racedAt = null;
    this.worldRound = null;
    this.mode = 'menu';
    this.screens.show('splash');
    this.screens.setOnlineNote(note);
  }

  /** The flag dropped. Build the world on the room's seed and go. */
  private async beginOnlineRace(startedAt: number | null): Promise<void> {
    if (!this.online) return;
    // Taken before the await: two room updates can land while the world is
    // being built, and the second must not start the same race again.
    this.racedAt = startedAt;
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
    // A guest does not get to decide how its own race ends - the host does,
    // and tells us on the next frame. Offline and on the host, we decide.
    this.world.authority = !(this.online !== null && !this.online.isHost);
    this.applySeatNames();

    this.view?.rebuild(this.world);

    this.worldRound = this.online ? this.racedAt : null;
    // Whatever was on its way for the last race is about this world's
    // predecessor and would be drawn onto this one: a grid from a road nobody
    // is on any more, on a clock that reads minutes ahead of this race's.
    this.online?.resetStream();

    this.accumulator = 0;
    this.lastFrame = performance.now();
    this.pendingSwings.length = 0;
    this.localControl = false;
    this.lastProgress = 0;
    this.lastProgressAtMs = 0;
    this.frameFaults = 0;
    this.wentSolo = false;
    this.linkTrouble = null;
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

  /**
   * Has the race actually moved since last time?
   *
   * `elapsed - countdown` rises through both phases - the countdown ticks
   * down before the flag and the clock counts up after it - so one number
   * covers the whole race. If it has not moved in four seconds while we are
   * supposedly racing, the race is stuck, whatever the reason.
   */
  private checkProgress(nowMs: number): void {
    if (this.mode !== 'racing' || this.linkTrouble) {
      this.lastProgressAtMs = nowMs;
      return;
    }
    const progress = this.world.elapsed - this.world.countdown;
    if (Math.abs(progress - this.lastProgress) > 1e-6) {
      this.lastProgress = progress;
      this.lastProgressAtMs = nowMs;
      return;
    }
    if (this.lastProgressAtMs === 0) {
      this.lastProgressAtMs = nowMs;
      return;
    }
    if (nowMs - this.lastProgressAtMs > WATCHDOG_MS) this.reportStuck();
  }

  /** Put the way out on screen. Deliberately the last word, never the first. */
  private reportStuck(): void {
    if (this.linkTrouble === 'stuck') return;
    this.linkTrouble = 'stuck';
    this.screens.showLink({ kind: 'stuck', pingMs: null });
  }

  /** Keep the HUD's connection badge in step with the link. */
  private updateLinkBadge(nowMs: number): void {
    const online = this.online;
    if (!online || this.mode !== 'racing') {
      this.hud.setLink(null);
      return;
    }
    this.hud.setLink({
      quality: online.quality(nowMs),
      pingMs: online.ping(nowMs),
      local: this.localControl,
    });
  }

  private togglePause(): void {
    if (this.mode === 'racing') this.pause();
    else if (this.mode === 'paused') this.resume();
  }

  pause(): void {
    if (this.mode !== 'racing') return;
    this.mode = 'paused';
    // Nobody can pause a race that other people are riding in, so in a room
    // the menu offers the room's way out rather than a restart that would
    // only ever restart your own.
    this.screens.setPauseRoom(this.online !== null);
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
    this.racedAt = null;
    this.worldRound = null;
    this.linkTrouble = null;
    this.localControl = false;
    this.hud.setLink(null);
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

    // Heartbeats run whatever the game is doing, so a link is measured in the
    // lobby as well as in a race and a silence is noticed the moment it starts.
    this.online?.tick(now);
    this.updateLinkBadge(now);

    // A throw in here used to cost the whole session: the loop survives it,
    // but if it throws every frame the picture simply stops and every control
    // goes dead with no explanation. Now it is counted, and a jam is reported.
    try {
      if (this.mode === 'racing') {
        this.stepSimulation(dt, input, now);
      } else if (this.servesOthers()) {
        // Our race is run; theirs is not. The world has to keep turning and,
        // on the host, keep going out on the wire - a host that stopped
        // simulating the moment it crossed the line took every other rider's
        // road away with it, and they simply stopped dead where they were.
        this.stepSimulation(dt, NEUTRAL, now);
      } else if (this.mode === 'menu' || this.mode === 'over') {
        // Keep the scene alive behind the menus and end screens.
        this.world.step(dt, NEUTRAL);
      }

      if (this.mode !== 'paused') {
        this.view?.render(dt, input);
      }
      if (this.mode === 'racing') {
        this.hud.update(this.world, dt);
      } else if (this.mode === 'over') {
        this.refreshResults();
      }
      this.frameFaults = 0;
    } catch (err) {
      this.frameFaults++;
      // Logged once rather than sixty times a second.
      if (this.frameFaults === 1) console.error('[motorush] frame failed', err);
      if (this.frameFaults > 30) this.reportStuck();
    }

    this.checkProgress(now);

    const cop = this.world.cop;
    const me = this.world.localRacer;
    this.audio.update(
      me.speed,
      input.throttle,
      isRiding(me),
      cop ? Math.abs(me.s - cop.s) : null,
    );
  };

  /**
   * Is this browser still on the hook for a race it is no longer riding in?
   *
   * The host is the race: its simulation is the one every guest draws, so it
   * keeps running until the last rider is home however its own race ended and
   * whatever screen it is looking at. A guest is on the hook for nothing, but
   * while it is watching the board fill in it keeps taking frames so the
   * places and times on that board are the real ones.
   */
  private servesOthers(): boolean {
    const online = this.online;
    if (!online || !online.started()) return false;
    // Not until the world in hand belongs to the race that is under way.
    if (this.worldRound === null || this.worldRound !== online.startedAt()) return false;
    if (this.world.raceComplete) return false;
    return online.isHost || this.mode === 'over';
  }

  /** Keep the results board in step with a race that is still being run. */
  private refreshResults(): void {
    if (this.screens.active !== 'finish') return;
    this.screens.showResults({
      standings: this.world.standingEntries(),
      raceDistance: this.world.raceDistance,
      complete: this.world.raceComplete,
    });
  }

  private stepSimulation(dt: number, input: RacerInput, nowMs: number): void {
    if (this.online && !this.online.isHost) {
      this.stepAsGuest(dt, input, nowMs);
      return;
    }

    this.queueAttacks();

    // Punches thrown by the other browsers. Drained rather than held: one
    // press is one swing, however many input frames carry the flag.
    for (const swing of this.online?.attacks() ?? []) {
      this.world.requestAttackFor(swing.id, swing.dir);
    }

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
      cops: this.world.cop ? [this.world.cop] : [],
      cars: this.world.traffic.cars,
      peds: this.world.pedestrians,
      aroundS: this.world.localRacer.s,
      time: this.world.elapsed,
      // How the RACE is going, not how the host's race is going. Sending the
      // host's own verdict put the host's BUSTED screen up on every guest.
      phase: this.world.phase,
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

    // Punches are events, so they travel as a flag on the next frame that
    // actually goes out rather than being sampled and lost.
    for (const side of this.input.consumeAttacks()) {
      const dir = side === 0 ? this.nearestSide() : side;
      this.pendingSwings.push(dir);
      // Thrown here as well as sent. The host decides whether it lands - that
      // is its job and ours to accept - but the arm has to move the moment
      // the button is pressed, or a punch on a long link feels like a button
      // that does not work. The swing is not taken back by a later frame,
      // only the damage is.
      this.world.requestAttack(dir);
    }
    // Both sides is the most that can travel on one frame, so anything beyond
    // a couple is only a queue growing behind a link that is not carrying
    // anything - and when it came back it would fire off a stored flurry.
    if (this.pendingSwings.length > 2) this.pendingSwings.splice(0, this.pendingSwings.length - 2);
    // Only while we are actually riding. Once our race is run we are watching
    // the board, and a stream of neutral frames would keep the host believing
    // somebody is holding this bike - when what should happen is the AI taking
    // it back the moment we stop asking for it.
    if (this.mode === 'racing') {
      const sent = online.sendInput({
        ...input,
        attackLeft: this.pendingSwings.includes(-1),
        attackRight: this.pendingSwings.includes(1),
      }, nowMs);
      if (sent) this.pendingSwings.length = 0;
    }

    // How long since the host last said anything. Infinity before the first
    // frame, which is the case that matters most: a link that never opened.
    const silentMs = online.snapshotAgeMs(nowMs);
    const live = silentMs < GUEST_HOLD_MS;
    this.setLocalControl(!live);

    // A decision is on screen. Hold the world exactly where it is rather than
    // riding on unsteered behind the panel - the controls are underneath it -
    // while still listening, because the host may yet come back.
    if (this.linkTrouble) {
      this.accumulator = 0;
      if (live) this.clearLinkTrouble();
      else this.judgeLink(silentMs, nowMs);
      return;
    }

    this.accumulator += dt;
    let steps = 0;
    const events: SimEvent[] = [];
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      // Our own bike is ridden here, on our own machine, whether or not the
      // host is talking to us - that is what keeps the controls alive. When
      // the host is quiet the AI picks up the other bikes too, so the race
      // carries on instead of standing still.
      events.push(...this.world.step(FIXED_DT, input));
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;

    const frame = live ? online.sample(nowMs) : null;
    if (!frame) {
      // Nothing to correct against: the local sim is the race for now, so its
      // own crashes and finishes have to count.
      if (events.length) this.dispatch(events);
      this.judgeLink(silentMs, nowMs);
      return;
    }

    const mine = frame.racers.find((r) => r.id === this.world.localRacer.id);
    // Everyone else is drawn exactly where the host says. Our own rider is
    // predicted and corrected, so a press moves the bike now rather than in
    // a round trip's time.
    applyRacers(this.world.racers, frame.racers, this.world.localRacer.id);
    if (mine) reconcileLocalRacer(this.world.localRacer, mine, dt);
    // Police are the host's business entirely; a guest just draws whichever
    // patrols it is told about.
    applyRacers(this.world.adoptCops(frame.cops.map((c) => c.id)), frame.cops);
    applyCars(this.world.traffic.cars, frame.cars);
    applyPeds(this.world.pedestrians, frame.peds);

    // The host owns the race clock too. Without this a guest that joined
    // mid-countdown runs its own lights, and one that joined late never sees
    // the race end at all - its local rider is never simulated, so it would
    // sit on the start line for ever.
    this.world.countdown = frame.countdown;
    if (frame.phase === 'racing' && this.world.state === 'countdown') this.world.state = 'racing';

    // How OUR race ended is written on our own bike. The host's verdict is the
    // host's: it crosses the line, gets arrested or gets flattened on its own
    // account, and none of that is an ending for anybody else. Reading the
    // race state as our own is what used to put the host's BUSTED screen up on
    // every guest - and what left a guest who came home first riding on with
    // no result at all, because the host was still out on the road.
    if (mine) this.readVerdict(mine);
    this.judgeLink(silentMs, nowMs);
  }

  /**
   * Flip between drawing the host's race and riding our own.
   *
   * Only the HUD needs telling: the switch itself is just which branch of the
   * guest step runs. Announced because a rider who does not know they have
   * gone local will not understand why the other bikes started behaving
   * differently.
   */
  private setLocalControl(local: boolean): void {
    if (local === this.localControl) return;
    this.localControl = local;
    if (this.mode !== 'racing') return;

    // The badge changes instantly; the toast does not. A link that drops a
    // burst of frames every few seconds would otherwise spend the whole race
    // announcing itself, which is worse than the stutter it is reporting.
    const now = performance.now();
    if (now - this.lastLinkToastMs < LINK_TOAST_GAP_MS) return;
    this.lastLinkToastMs = now;
    this.hud.toast(
      local ? 'HOST QUIET — RIDING LOCALLY' : 'BACK ONLINE',
      local ? 'bad' : 'good',
    );
  }

  /**
   * Decide whether a silence is worth interrupting the race for.
   *
   * Kept apart from the stepping because it is a policy decision, not
   * simulation: how long to wait, when to say something, and when to stop
   * pretending it is coming back.
   */
  private judgeLink(silentMs: number, nowMs: number): void {
    // Told to get on with it, or already at the results: nothing to decide.
    if (this.wentSolo || this.mode !== 'racing') return;

    if (silentMs < GUEST_PATIENCE_MS) {
      // Recovered, or never actually broke.
      if (this.linkTrouble === 'recovering') this.clearLinkTrouble();
      return;
    }
    if (this.linkTrouble === 'host-left') return; // a fact, not a wait

    // Past the give-up mark it is no longer honest to call this a wait.
    this.linkTrouble = silentMs > GUEST_GIVE_UP_MS ? 'lost' : 'recovering';
    this.screens.showLink({
      kind: this.linkTrouble,
      progress: 1 - (silentMs - GUEST_PATIENCE_MS) / (GUEST_GIVE_UP_MS - GUEST_PATIENCE_MS),
      pingMs: this.online?.ping(nowMs) ?? null,
    });
  }

  /** The host came back. Put the race back on screen where we left it. */
  private clearLinkTrouble(): void {
    if (!this.linkTrouble) return;
    this.linkTrouble = null;
    if (this.mode === 'racing') this.screens.hideAll();
  }

  /**
   * Stop waiting for the room and finish the race here.
   *
   * The world is already running locally by this point - that is what the
   * recovery does - so this only drops the link and takes the screen down.
   * Deliberately NOT a restart: a rider five kilometres into a race does not
   * want to be sent back to the start line because somebody else's wifi died.
   */
  private continueOffline(): void {
    // A jam is not a network problem, so carrying on where we stand would
    // only carry on being jammed. Start the race again instead.
    if (this.linkTrouble === 'stuck') {
      this.linkTrouble = null;
      this.frameFaults = 0;
      this.lastProgressAtMs = 0;
      void this.startRace(this.options);
      return;
    }
    this.wentSolo = true;
    this.linkTrouble = null;
    this.localControl = false;
    // Nobody left to defer to: from here this browser decides how its own race
    // ends, or it could never end at all.
    this.world.authority = true;
    void this.online?.close().catch(() => {});
    this.online = null;
    this.hud.setLink(null);
    if (this.mode === 'racing') {
      this.screens.hideAll();
      this.lastFrame = performance.now();
      this.accumulator = 0;
      return;
    }
    // Paused when the room went away: the panel replaced the pause screen, so
    // put that back rather than throwing away a race they were part way
    // through and had not asked to leave.
    if (this.mode === 'paused') {
      this.screens.show('pause');
      return;
    }
    this.quitToMenu();
  }

  /**
   * The host's word on how our own race ended.
   *
   * Only ever about our own bike. It goes through the same `concludeLocal` and
   * the same result screen an offline race uses, so a guest's finish board is
   * built from the same numbers - including the time, which is the host's
   * clock and therefore the one everybody in the room agrees on.
   */
  private readVerdict(mine: RacerSnapshot): void {
    if (this.mode !== 'racing' || this.world.isOver) return;
    // Belt and braces: a frame that arrives before the flag is not a frame
    // about this race, and no result read off one can be right.
    if (this.world.state === 'countdown') return;
    if (mine.state === 'finished') {
      this.dispatch(this.world.concludeLocal('finished', mine.finishTime));
    } else if (mine.state === 'busted') {
      this.dispatch(this.world.concludeLocal('busted'));
    }
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
        // In a room the way out is about the room: wait for the next race, or
        // give the seat up. Racing again on your own is not a thing you can do
        // without walking out on the people you are racing.
        this.screens.showResult(e.result, { inRoom: this.online !== null });
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
      input: () => this.input.sample(),
      link: () => this.linkTrouble,
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

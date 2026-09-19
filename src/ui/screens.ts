// Full-screen overlays: loading, splash/menu, pause, and the three end screens
// (BUSTED, WASTED and the finish board).

import type { DifficultyKey, RaceResult, StandingEntry } from '../sim/types';
import { formatTime, formatGap, ordinal, mps2kmh, formatKm } from '../sim/mathx';
import {
  generateRiderName,
  initialRiderName,
  normaliseRiderName,
  saveRiderName,
} from './ridername';

export type ScreenName =
  | 'loading' | 'splash' | 'lobby' | 'pause' | 'link' | 'busted' | 'wasted' | 'finish';

/**
 * Why the connection screen is up.
 *
 * `recovering` is hopeful and times out. The rest are settled, and differ
 * only in what we can honestly tell the player about what happened - which
 * is worth the extra words, because "the owner left" and "we have no idea"
 * call for different things from the person reading them.
 */
export type LinkTrouble = 'recovering' | 'host-left' | 'lost' | 'stuck';

export interface LinkView {
  kind: LinkTrouble;
  /** 1 at the start of the recovery window, 0 when it has run out. */
  progress?: number;
  /** Round trip when we last had one, for the "it was this bad" line. */
  pingMs?: number | null;
}

/** One row of the grid on the lobby screen. */
export interface LobbyRider {
  slot: number;
  name: string;
  isYou: boolean;
  isHost: boolean;
}

export interface LobbyView {
  code: string;
  riders: LobbyRider[];
  /** Only the owner gets a start button. */
  youAreHost: boolean;
  /** Total seats on the grid; the rest are bots. */
  gridSize: number;
}

export interface StartOptions {
  riderName: string;
  difficulty: DifficultyKey;
}

/**
 * What the board should say right now.
 *
 * The finish screen is not a photograph. Cross the line first and six riders
 * are still out there settling the rest of the places, so the results list
 * keeps being handed this until the last of them is in.
 */
export interface ResultsView {
  standings: readonly StandingEntry[];
  /** For working out how far a rider still out on the road has left to go. */
  raceDistance: number;
  /** Nobody left racing: the times on the board are final. */
  complete: boolean;
}

export interface ResultOptions {
  /**
   * In a room. The buttons stop being about racing again on your own and
   * start being about the room: wait for the next one, or get out.
   */
  inRoom: boolean;
}

export interface ScreenCallbacks {
  onStart(opts: StartOptions): void;
  /** Quick Match, a new private room, or a code somebody read out. */
  onOnline(intent: 'quick' | 'create' | 'join', opts: StartOptions & { code?: string }): void;
  /** Owner dropped the flag. */
  onLaunch(): void;
  onLeaveRoom(): void;
  /** Done racing, but staying in the room: wait for the next one. */
  onBackToLobby(): void;
  onResume(): void;
  /** Give up on the link and finish the race against bots. */
  onContinueOffline(): void;
  onRestart(): void;
  onQuit(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const SCREEN_IDS: Record<ScreenName, string> = {
  loading: 'screen-loading',
  splash: 'screen-splash',
  lobby: 'screen-lobby',
  pause: 'screen-pause',
  link: 'screen-link',
  busted: 'screen-busted',
  wasted: 'screen-wasted',
  finish: 'screen-finish',
};

/** Only touch the DOM when the text actually changed. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * What each kind of trouble says.
 *
 * Plain about what is happening and what it means for the race, because the
 * one thing worse than losing the connection is not being told you have.
 */
const LINK_COPY: Record<LinkTrouble, { title: string; blurb: string; action: string }> = {
  recovering: {
    title: 'RECONNECTING',
    blurb: 'Lost the host. You are riding on your own machine while we try to get it back.',
    action: 'RACE THE BOTS INSTEAD',
  },
  'host-left': {
    title: 'THE OWNER LEFT',
    blurb: 'Whoever opened the room closed it. The race can carry on against bots.',
    action: 'FINISH THE RACE',
  },
  lost: {
    title: 'CONNECTION LOST',
    blurb: 'The host stopped answering. Nothing is coming back, so this race is yours alone now.',
    action: 'FINISH THE RACE',
  },
  /**
   * The catch-all, and the one that must never be reachable by sitting there
   * doing nothing. If the race stops advancing for any reason at all - a
   * reason this code has not thought of - the watchdog puts this up, because
   * a panel with two working buttons beats a frozen picture every time.
   */
  stuck: {
    title: 'THE RACE STOPPED',
    blurb: 'Something jammed and the road stopped moving. Nothing you did caused it.',
    action: 'RESTART THE RACE',
  },
};

/** Build one <div><dt>LABEL</dt><dd>value</dd></div> stat tile. */
function statTile(label: string, value: string): HTMLDivElement {
  const wrap = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  wrap.append(dt, dd);
  return wrap;
}

export class Screens {
  private current: ScreenName | null = null;
  private difficulty: DifficultyKey = 'normal';
  /** What the results board last said, so a live refresh can do nothing. */
  private resultsSignature = '';

  constructor(private readonly callbacks: ScreenCallbacks) {
    this.wireSplash();
    this.wireLobby();
    this.wirePause();
    this.wireLink();
    this.wireVerdicts();
    detectArt();
  }

  private wireSplash(): void {
    // Start on whatever this browser raced under last, or a made-up one, so
    // the field is never blank and nobody has to invent a handle to play.
    const nameField = $<HTMLInputElement>('rider-name');
    nameField.value = initialRiderName();

    const choices = $('difficulty-choices');
    choices.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-difficulty]');
      if (!btn) return;
      this.difficulty = btn.dataset.difficulty as DifficultyKey;
      for (const c of choices.querySelectorAll<HTMLButtonElement>('.choice')) {
        const active = c === btn;
        c.classList.toggle('is-active', active);
        c.setAttribute('aria-checked', String(active));
      }
    });

    /** Whatever is in the name field, tidied and remembered. */
    const settle = (): StartOptions => {
      // A cleared field means "you pick"; hand back a real name rather than a
      // blank, and show them what they are racing as.
      const typed = normaliseRiderName(nameField.value);
      const riderName = saveRiderName(typed || generateRiderName());
      nameField.value = riderName;
      return { riderName, difficulty: this.difficulty };
    };

    $('btn-start').addEventListener('click', () => {
      this.callbacks.onStart(settle());
    });

    $('btn-quick').addEventListener('click', () => {
      this.setOnlineNote('');
      this.callbacks.onOnline('quick', settle());
    });

    $('btn-create').addEventListener('click', () => {
      this.setOnlineNote('');
      this.callbacks.onOnline('create', settle());
    });

    const codeField = $<HTMLInputElement>('room-code');
    const join = () => {
      const code = codeField.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length < 4) {
        this.setOnlineNote('Room codes are four characters.');
        return;
      }
      this.setOnlineNote('');
      this.callbacks.onOnline('join', { ...settle(), code });
    };
    $('btn-join').addEventListener('click', join);
    codeField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });

    const card = $('controls-card');
    $('btn-controls').addEventListener('click', () => {
      card.hidden = !card.hidden;
    });

    // Enter starts the race from the name field.
    $<HTMLInputElement>('rider-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('btn-start').click();
    });
  }

  /**
   * Reveal the online section.
   *
   * Shown either way: hiding it when sign-in fails leaves a player tapping a
   * button that is not there and no way to tell why. Unavailable means
   * visibly unavailable, with a reason.
   */
  /**
   * Show the online doors.
   *
   * They are never disabled, even before sign-in has landed or after it has
   * failed. A dead button tells the player nothing and leaves them nothing to
   * do; a live one lets them ask again, and asking again is what triggers
   * another attempt. The note underneath carries the bad news instead.
   */
  enableOnline(available: boolean, reason = ''): void {
    $('menu-online').hidden = false;
    for (const id of ['btn-quick', 'btn-create', 'btn-join']) {
      $<HTMLButtonElement>(id).disabled = false;
    }
    $<HTMLInputElement>('room-code').disabled = false;
    this.setOnlineNote(available ? '' : reason);
  }

  /** A message under the online buttons - a bad code, a room that was full. */
  setOnlineNote(text: string): void {
    $('online-note').textContent = text;
  }

  private wireLobby(): void {
    $('btn-launch').addEventListener('click', () => this.callbacks.onLaunch());
    $('btn-leave-room').addEventListener('click', () => this.callbacks.onLeaveRoom());
  }

  /** Draw the room: its code, who is on the grid, and whose move it is. */
  showLobby(view: LobbyView): void {
    $('lobby-code').textContent = view.code || '----';
    $('lobby-hint').textContent = view.youAreHost
      ? 'Read the code out to a friend, then start when you are ready.'
      : 'Waiting for the room owner to start.';

    const rows = [];
    for (let slot = 0; slot < view.gridSize; slot++) {
      const rider = view.riders.find((r) => r.slot === slot);
      const li = document.createElement('li');
      li.className = rider ? (rider.isYou ? 'is-you' : '') : 'is-bot';

      const no = document.createElement('span');
      no.className = 'seat-no';
      no.textContent = String(slot + 1);

      const name = document.createElement('span');
      // An empty seat is not a gap to be filled before racing - it is a bot.
      name.textContent = rider ? rider.name : 'BOT';

      const tag = document.createElement('span');
      tag.className = 'seat-tag';
      tag.textContent = rider?.isHost ? 'OWNER' : rider?.isYou ? 'YOU' : '';

      li.append(no, name, tag);
      rows.push(li);
    }
    $('lobby-grid').replaceChildren(...rows);

    const humans = view.riders.length;
    $('lobby-status').textContent =
      humans === 1 ? 'JUST YOU SO FAR' : `${humans} RIDERS IN THE ROOM`;

    $('btn-launch').hidden = !view.youAreHost;
    this.show('lobby');
  }

  private wirePause(): void {
    $('btn-resume').addEventListener('click', () => this.callbacks.onResume());
    $('btn-restart-pause').addEventListener('click', () => this.callbacks.onRestart());
    $('btn-pause-lobby').addEventListener('click', () => this.callbacks.onBackToLobby());
    $('btn-quit').addEventListener('click', () => this.callbacks.onQuit());
  }

  /**
   * Which way out the pause menu offers.
   *
   * Restarting is a thing you can do to your own race and not to anybody
   * else's, so in a room it is replaced by stepping out of the race and back
   * into the room the others are still riding in.
   */
  setPauseRoom(inRoom: boolean): void {
    $('btn-restart-pause').hidden = inRoom;
    $('btn-pause-lobby').hidden = !inRoom;
  }

  private wireLink(): void {
    $('btn-link-continue').addEventListener('click', () => this.callbacks.onContinueOffline());
    $('btn-link-quit').addEventListener('click', () => this.callbacks.onQuit());
  }

  /**
   * Put the connection screen up, or refresh the one already there.
   *
   * Called every frame while the trouble lasts, so it only writes what has
   * actually changed - reassigning identical text each frame would restart
   * the meter's transition and make it stutter.
   */
  showLink(view: LinkView): void {
    const copy = LINK_COPY[view.kind];
    setText($('link-title'), copy.title);
    setText($('link-blurb'), copy.blurb);
    setText($<HTMLButtonElement>('btn-link-continue'), copy.action);

    const meter = $('link-fill').parentElement as HTMLElement;
    const recovering = view.kind === 'recovering';
    meter.hidden = !recovering;
    if (recovering) {
      const left = Math.max(0, Math.min(1, view.progress ?? 1));
      $('link-fill').style.width = `${left * 100}%`;
    }

    // The last good round trip, when there was one: it turns "it broke" into
    // "it was already struggling", which is usually the true story.
    setText(
      $('link-detail'),
      view.pingMs == null ? '' : `LAST PING ${Math.round(view.pingMs)} ms`,
    );

    if (this.current !== 'link') this.show('link');
  }

  private wireVerdicts(): void {
    for (const id of ['screen-busted', 'screen-wasted', 'screen-finish']) {
      $(id).addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
        if (!btn) return;
        switch (btn.dataset.action) {
          case 'restart': this.callbacks.onRestart(); break;
          case 'lobby': this.callbacks.onBackToLobby(); break;
          // Leaving the room and going to the menu are the same journey; the
          // button says the part the player cares about, which is that the
          // seat they were holding is given up.
          case 'leave': this.callbacks.onQuit(); break;
          default: this.callbacks.onQuit(); break;
        }
      });
    }
  }

  /** Show the room's buttons instead of the solo ones on an end screen. */
  private setRoomActions(screen: 'busted' | 'wasted' | 'finish', inRoom: boolean): void {
    const solo = $(`screen-${screen}`).querySelector<HTMLElement>('.verdict__actions');
    const room = $(`${screen}-room-actions`);
    if (solo) solo.hidden = inRoom;
    room.hidden = !inRoom;
  }

  // ------------------------------------------------------------------ show
  show(name: ScreenName): void {
    this.current = name;
    for (const [key, id] of Object.entries(SCREEN_IDS)) {
      $(id).hidden = key !== name;
    }
  }

  hideAll(): void {
    this.current = null;
    for (const id of Object.values(SCREEN_IDS)) $(id).hidden = true;
  }

  get active(): ScreenName | null {
    return this.current;
  }

  setLoadingText(text: string): void {
    $('loading-text').textContent = text;
  }

  /** Render the appropriate end screen for a finished race. */
  showResult(result: RaceResult, options: ResultOptions = { inRoom: false }): void {
    for (const screen of ['busted', 'wasted', 'finish'] as const) {
      this.setRoomActions(screen, options.inRoom);
    }
    const shared: [string, string][] = [
      ['TIME', formatTime(result.time)],
      ['TOP SPEED', `${Math.round(mps2kmh(result.topSpeed))} km/h`],
      ['TAKEDOWNS', String(result.takedowns)],
      ['CRASHES', String(result.crashes)],
    ];

    if (result.reason === 'busted') {
      $('busted-stats').replaceChildren(
        ...shared.map(([l, v]) => statTile(l, v)),
        statTile('DISTANCE', formatKm(result.distance)),
      );
      this.show('busted');
      return;
    }

    if (result.reason === 'wasted') {
      $('wasted-stats').replaceChildren(
        ...shared.map(([l, v]) => statTile(l, v)),
        statTile('DISTANCE', formatKm(result.distance)),
      );
      this.show('wasted');
      return;
    }

    // --- finished ---
    const won = result.place === 1;
    const stamp = $('finish-stamp');
    stamp.textContent = ordinal(result.place);
    stamp.className = `verdict__stamp verdict__stamp--${won ? 'win' : 'placed'}`;

    const screen = $('screen-finish');
    screen.classList.toggle('art--winner', won);

    $('finish-blurb').textContent = won
      ? 'You took the win. The road belongs to you.'
      : result.place <= 3
        ? 'On the podium — but not on top.'
        : 'You finished. Barely.';

    this.showResults({
      standings: result.standings,
      raceDistance: result.raceDistance,
      // Finishing first does not finish the race. Whether it is over is
      // something only the world knows, and it says so on the next refresh.
      complete: result.standings.every((e) => e.time != null),
    });

    $('finish-stats').replaceChildren(...shared.map(([l, v]) => statTile(l, v)));
    this.show('finish');
  }

  /**
   * Redraw the results board with wherever the race has got to.
   *
   * Called every frame while the finish screen is up, so it writes nothing
   * unless something actually moved - the board is eight rows and most frames
   * change none of them.
   */
  showResults(view: ResultsView): void {
    const rows = view.standings.map((entry) => [
      String(entry.place),
      entry.name,
      entry.time != null
        ? formatTime(entry.time)
        // Still out there: how much road they have left, which is the only
        // honest thing to print. DNF is for riders who never got home.
        : view.complete
          ? 'DNF'
          : formatGap(-Math.max(0, view.raceDistance - entry.s)),
      entry.isPlayer ? 'you' : '',
    ] as const);

    const signature = rows.map((r) => r.join('\u0000')).join('\u0001');
    if (signature === this.resultsSignature) return;
    this.resultsSignature = signature;

    $('finish-results').replaceChildren(
      ...rows.map(([place, name, time, you]) => {
        const li = document.createElement('li');
        if (you) li.className = 'is-player';
        const pos = document.createElement('span');
        pos.className = 'pos';
        pos.textContent = place;
        const who = document.createElement('span');
        who.textContent = name;
        const when = document.createElement('span');
        when.className = 'time';
        when.textContent = time;
        li.append(pos, who, when);
        return li;
      }),
    );

    setText(
      $('finish-note'),
      view.complete ? 'EVERY RIDER IS IN' : 'THE RACE IS STILL ON — THIS BOARD IS LIVE',
    );
  }
}

/**
 * Screens fall back to a gradient when their painting is missing, and the
 * painting usually has the title lettered into it already. Probe each file and
 * mark the screen when it loads, so the HTML heading can step aside rather
 * than printing BUSTED over the top of a painted BUSTED.
 */
const ART: Record<string, string> = {
  'screen-splash': '/art/splash.jpg',
  'screen-busted': '/art/busted.jpg',
  'screen-wasted': '/art/wasted.jpg',
  'screen-finish': '/art/winner.jpg',
};

function detectArt(): void {
  for (const [id, src] of Object.entries(ART)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const probe = new Image();
    probe.onload = () => el.classList.add('has-art');
    probe.src = src;
  }
}

// Full-screen overlays: loading, splash/menu, pause, and the three end screens
// (BUSTED, WASTED and the finish board).

import type { DifficultyKey, RaceResult } from '../sim/types';
import { formatTime, ordinal, mps2kmh, formatKm } from '../sim/mathx';
import {
  generateRiderName,
  initialRiderName,
  normaliseRiderName,
  saveRiderName,
} from './ridername';

export type ScreenName =
  | 'loading' | 'splash' | 'lobby' | 'pause' | 'busted' | 'wasted' | 'finish';

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

export interface ScreenCallbacks {
  onStart(opts: StartOptions): void;
  /** Quick Match, a new private room, or a code somebody read out. */
  onOnline(intent: 'quick' | 'create' | 'join', opts: StartOptions & { code?: string }): void;
  /** Owner dropped the flag. */
  onLaunch(): void;
  onLeaveRoom(): void;
  onResume(): void;
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
  busted: 'screen-busted',
  wasted: 'screen-wasted',
  finish: 'screen-finish',
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

  constructor(private readonly callbacks: ScreenCallbacks) {
    this.wireSplash();
    this.wireLobby();
    this.wirePause();
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

  /** Reveal the online buttons. Called once we know we have a session. */
  enableOnline(): void {
    $('menu-online').hidden = false;
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
    $('btn-quit').addEventListener('click', () => this.callbacks.onQuit());
  }

  private wireVerdicts(): void {
    for (const id of ['screen-busted', 'screen-wasted', 'screen-finish']) {
      $(id).addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
        if (!btn) return;
        if (btn.dataset.action === 'restart') this.callbacks.onRestart();
        else this.callbacks.onQuit();
      });
    }
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
  showResult(result: RaceResult): void {
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

    $('finish-results').replaceChildren(
      ...result.standings.map((entry) => {
        const li = document.createElement('li');
        if (entry.isPlayer) li.className = 'is-player';
        const pos = document.createElement('span');
        pos.className = 'pos';
        pos.textContent = String(entry.place);
        const name = document.createElement('span');
        name.textContent = entry.name;
        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = entry.time != null ? formatTime(entry.time) : 'DNF';
        li.append(pos, name, time);
        return li;
      }),
    );

    $('finish-stats').replaceChildren(...shared.map(([l, v]) => statTile(l, v)));
    this.show('finish');
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

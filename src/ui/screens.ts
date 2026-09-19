// Full-screen overlays: loading, splash/menu, pause, and the three end screens
// (BUSTED, WASTED and the finish board).

import type { DifficultyKey, RaceResult } from '../sim/types';
import { formatTime, ordinal, mps2kmh } from '../sim/mathx';

export type ScreenName = 'loading' | 'splash' | 'pause' | 'busted' | 'wasted' | 'finish';

export interface StartOptions {
  riderName: string;
  difficulty: DifficultyKey;
}

export interface ScreenCallbacks {
  onStart(opts: StartOptions): void;
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
    this.wirePause();
    this.wireVerdicts();
  }

  private wireSplash(): void {
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

    $('btn-start').addEventListener('click', () => {
      const input = $<HTMLInputElement>('rider-name');
      const riderName = (input.value || 'YOU').toUpperCase().slice(0, 12);
      this.callbacks.onStart({ riderName, difficulty: this.difficulty });
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
      ['TOP SPEED', `${Math.round(mps2kmh(result.topSpeed))}`],
      ['TAKEDOWNS', String(result.takedowns)],
      ['CRASHES', String(result.crashes)],
    ];

    if (result.reason === 'busted') {
      $('busted-stats').replaceChildren(
        ...shared.map(([l, v]) => statTile(l, v)),
        statTile('DISTANCE', `${Math.round(result.distance)}m`),
      );
      this.show('busted');
      return;
    }

    if (result.reason === 'wasted') {
      $('wasted-stats').replaceChildren(
        ...shared.map(([l, v]) => statTile(l, v)),
        statTile('DISTANCE', `${Math.round(result.distance)}m`),
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

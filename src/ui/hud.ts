// Heads-up display. Reads simulation state each frame and pushes it into the
// DOM; owns no game state of its own.

import type { World } from '../sim/world';
import type { SimEvent } from '../sim/types';
import { formatTime, ordinal, mps2kmh, clamp } from '../sim/mathx';
import { POLICE } from '../sim/config';
import type { InputManager, AttackSide } from '../input/input';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

type ToastKind = 'good' | 'hot' | 'bad' | 'cool';

export class Hud {
  private readonly root = $('hud');
  private readonly place = $('hud-place');
  private readonly field = $('hud-field');
  private readonly timer = $('hud-timer');
  private readonly distance = $('hud-distance');
  private readonly total = $('hud-total');
  private readonly progress = $('hud-progress');
  private readonly health = $('hud-health');
  private readonly weapon = $('hud-weapon');
  private readonly boost = $('hud-boost');
  private readonly speed = $('hud-speed');
  private readonly pursuit = $('hud-pursuit');
  private readonly bust = $('hud-bust');
  private readonly pursuitHint = $('hud-pursuit-hint');
  private readonly heat = $('hud-heat');
  private readonly heatFill = $('hud-heat-fill');
  private readonly centre = $('hud-centre');
  private readonly toasts = $('hud-toasts');
  private readonly flash = $('hud-flash');
  private readonly touchControls = $('touch-controls');

  private flashTimer = 0;

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  /** Wire the on-screen controls. Only shown when the device reports touch. */
  enableTouch(input: InputManager): void {
    const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (!isTouch) return;
    this.touchControls.hidden = false;

    const buttons = this.touchControls.querySelectorAll<HTMLButtonElement>('[data-touch]');
    for (const btn of buttons) {
      const action = btn.dataset.touch as string;
      const press = (down: boolean) => (e: Event) => {
        e.preventDefault();
        btn.classList.toggle('is-down', down);
        switch (action) {
          case 'left': input.setTouch({ steer: down ? -1 : 0 }); break;
          case 'right': input.setTouch({ steer: down ? 1 : 0 }); break;
          case 'throttle': input.setTouch({ throttle: down ? 1 : 0 }); break;
          case 'brake': input.setTouch({ brake: down ? 1 : 0 }); break;
          case 'attack-left': if (down) input.queueAttack(-1 as AttackSide); break;
          case 'attack-right': if (down) input.queueAttack(1 as AttackSide); break;
          default: break;
        }
      };
      btn.addEventListener('pointerdown', press(true));
      btn.addEventListener('pointerup', press(false));
      btn.addEventListener('pointercancel', press(false));
      btn.addEventListener('pointerleave', press(false));
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  // --------------------------------------------------------------- per frame
  update(world: World, dt: number): void {
    const p = world.player;

    this.place.textContent = ordinal(p.place);
    this.field.textContent = `/ ${world.racers.length}`;
    this.timer.textContent = formatTime(world.elapsed);

    const travelled = Math.max(0, Math.min(p.s, world.raceDistance));
    this.distance.textContent = String(Math.round(travelled));
    this.total.textContent = String(world.raceDistance);
    this.progress.style.width = `${world.progress * 100}%`;

    const pct = clamp(p.health / p.maxHealth, 0, 1);
    this.health.style.width = `${pct * 100}%`;
    this.health.classList.toggle('is-hurt', pct <= 0.55 && pct > 0.25);
    this.health.classList.toggle('is-critical', pct <= 0.25);

    this.weapon.hidden = p.weapon === 'fist';
    if (p.weapon !== 'fist') {
      this.weapon.textContent = `${p.weapon.toUpperCase()} ${Math.ceil(p.weaponTimer)}s`;
    }
    this.boost.hidden = p.boostTimer <= 0;

    this.speed.textContent = String(Math.round(mps2kmh(p.speed)));

    // --- police ---
    if (world.cop) {
      this.pursuit.hidden = false;
      this.heat.hidden = true;
      this.bust.style.width = `${world.bustProgress * 100}%`;
      const lead = p.s - world.cop.s;
      const gap = Math.abs(p.s - world.cop.s);
      this.pursuitHint.textContent =
        lead > POLICE.escapeDistance * 0.7
          ? 'ALMOST CLEAR — KEEP GOING'
          : gap < POLICE.dangerRange
            ? 'STAY UPRIGHT — CRASH AND YOU ARE DONE'
            : 'OUTRUN THEM OR KNOCK THEM DOWN';
    } else {
      this.pursuit.hidden = true;
      const hot = world.heat > 8;
      this.heat.hidden = !hot;
      if (hot) this.heatFill.style.width = `${(world.heat / POLICE.heatMax) * 100}%`;
    }

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.flash.classList.remove('is-hit');
    }
  }

  // ----------------------------------------------------------------- effects
  showCentre(text: string, modifier = '', ms = 800): void {
    const el = document.createElement('div');
    el.className = `centre__item ${modifier ? `centre__item--${modifier}` : ''}`;
    el.textContent = text;
    this.centre.replaceChildren(el);
    window.setTimeout(() => {
      if (el.isConnected) el.remove();
    }, ms);
  }

  toast(text: string, kind: ToastKind = 'hot'): void {
    const el = document.createElement('div');
    el.className = `toast toast--${kind}`;
    el.textContent = text;
    this.toasts.append(el);
    window.setTimeout(() => el.remove(), 1200);
  }

  flashDamage(): void {
    this.flash.classList.add('is-hit');
    this.flashTimer = 0.28;
  }

  clearTransient(): void {
    this.centre.replaceChildren();
    this.toasts.replaceChildren();
    this.flash.classList.remove('is-hit');
  }

  /** Turn events into readable feedback. */
  handleEvents(events: readonly SimEvent[], world: World): void {
    const player = world.player;
    for (const e of events) {
      switch (e.type) {
        case 'countdown':
          this.showCentre(e.value > 0 ? String(e.value) : 'GO!', e.value === 0 ? 'go' : '', 900);
          break;
        case 'holeshot':
          this.toast('HOLESHOT!', 'good');
          break;
        case 'hit':
          if (e.attacker === player) {
            this.toast(e.fatal ? 'TAKEDOWN!' : `${e.weapon === 'fist' ? 'PUNCH' : 'CLUB'} +${e.damage}`, 'good');
          } else if (e.victim === player) {
            this.flashDamage();
            this.toast(`-${e.damage}`, 'bad');
          }
          break;
        case 'crash':
          if (e.racer === player) {
            this.flashDamage();
            this.toast('DOWN!', 'bad');
          }
          break;
        case 'pickup':
          if (e.racer === player) {
            const label = e.kind === 'health' ? 'PATCHED UP' : e.kind === 'club' ? 'GOT A CLUB' : 'NITRO!';
            this.toast(label, e.kind === 'boost' ? 'cool' : 'good');
          }
          break;
        case 'placeChange':
          if (e.place < e.from) this.toast(`${ordinal(e.place)} PLACE`, 'hot');
          break;
        case 'pedestrianHit':
          if (e.racer === player) this.toast('PEDESTRIAN!', 'hot');
          break;
        case 'copSpawn':
          this.showCentre('BUSTED?', '', 700);
          this.toast('HIGHWAY PATROL ON YOUR TAIL', 'bad');
          break;
        case 'copGiveUp':
          this.toast(e.reason === 'outrun' ? 'LOST THEM!' : 'PATROL DOWN!', 'good');
          break;
        default:
          break;
      }
    }
  }
}

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
  /** Lives outside the HUD so it survives the HUD being hidden. */
  private readonly pauseButton = document.getElementById('btn-pause');
  private readonly net = $('hud-net');
  private readonly netDot = $('hud-net-dot');
  private readonly netText = $('hud-net-text');

  private flashTimer = 0;

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    // Nothing to pause unless a race is on.
    if (this.pauseButton) this.pauseButton.hidden = !visible;
  }

  /**
   * The connection badge.
   *
   * `null` is an offline race: no link, so no opinion. Otherwise the round
   * trip, or what is wrong with it - and `local` marks the stretch where the
   * guest is riding on its own simulation because nothing is arriving.
   */
  setLink(status: { quality: 'good' | 'fair' | 'poor' | 'lost'; pingMs: number | null; local: boolean } | null): void {
    if (!status) {
      this.net.hidden = true;
      return;
    }
    this.net.hidden = false;
    for (const q of ['good', 'fair', 'poor', 'lost'] as const) {
      this.net.classList.toggle(`is-${q}`, status.quality === q);
    }
    const text = status.local
      ? 'LOCAL CONTROL'
      : status.pingMs == null
        ? 'LINKING'
        : `${Math.round(status.pingMs)} ms`;
    if (this.netText.textContent !== text) this.netText.textContent = text;
    this.netDot.title = status.local ? 'Riding locally while the host is quiet' : text;
  }

  /** Wire the on-screen controls. Only shown when the device reports touch. */
  enableTouch(input: InputManager): void {
    const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (!isTouch) return;
    this.touchControls.hidden = false;

    // What is under a thumb right now.
    //
    // Held as a set rather than written straight through, because the two
    // steering buttons share one axis: pressing right while still holding
    // left, then letting go of right, used to send the steering to centre
    // even though left was never released. On a phone, where a thumb rolls
    // from one button to the next, that reads as the controls dying
    // mid-corner.
    const held = new Set<string>();
    const applySteer = () => {
      const steer = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
      input.setTouch({ steer });
    };

    const buttons = this.touchControls.querySelectorAll<HTMLButtonElement>('[data-touch]');
    for (const btn of buttons) {
      const action = btn.dataset.touch as string;
      const press = (down: boolean) => (e: Event) => {
        e.preventDefault();
        if (down) held.add(action);
        else held.delete(action);
        btn.classList.toggle('is-down', down);
        switch (action) {
          case 'left':
          case 'right': applySteer(); break;
          case 'throttle': input.setTouch({ throttle: down ? 1 : 0 }); break;
          case 'brake': input.setTouch({ brake: down ? 1 : 0 }); break;
          case 'attack-left': if (down) input.queueAttack(-1 as AttackSide); break;
          case 'attack-right': if (down) input.queueAttack(1 as AttackSide); break;
          default: break;
        }
      };
      // Pointer events where they exist - every current mobile browser, iOS
      // Safari included - and raw touch events where they do not, so an older
      // Safari still gets working controls rather than dead buttons.
      if (typeof window.PointerEvent !== 'function') {
        btn.addEventListener('touchstart', press(true), { passive: false });
        btn.addEventListener('touchend', press(false));
        btn.addEventListener('touchcancel', press(false));
        btn.addEventListener('contextmenu', (e) => e.preventDefault());
        continue;
      }

      btn.addEventListener('pointerdown', (e) => {
        // Capture the pointer so a finger that slides off the button keeps
        // driving it - on a phone your thumb never stays put.
        try {
          btn.setPointerCapture((e as PointerEvent).pointerId);
        } catch {
          /* not all pointers can be captured; the handlers still work */
        }
        press(true)(e);
      });
      btn.addEventListener('pointerup', press(false));
      btn.addEventListener('pointercancel', press(false));
      // A pointer that ends up somewhere else - an alert, a tab switch, a
      // gesture the browser claimed - never sends pointerup here, and the
      // button would stay stuck on.
      btn.addEventListener('lostpointercapture', press(false));
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  // --------------------------------------------------------------- per frame
  update(world: World, dt: number): void {
    const p = world.localRacer;

    this.place.textContent = ordinal(p.place);
    this.field.textContent = `/ ${world.racers.length}`;
    this.timer.textContent = formatTime(world.elapsed);

    const travelled = Math.max(0, Math.min(p.s, world.raceDistance));
    // Kilometres, to match the end-of-race panel. Two decimals move often
    // enough at racing speed to read as progress rather than a frozen number.
    this.distance.textContent = (travelled / 1000).toFixed(2);
    this.total.textContent = (world.raceDistance / 1000).toFixed(2);
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
    const player = world.localRacer;
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

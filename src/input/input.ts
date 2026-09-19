// Input: keyboard, gamepad and on-screen touch controls, merged into one
// RacerInput each frame.

import { clamp } from '../sim/mathx';
import type { RacerInput } from '../sim/types';

export type AttackSide = -1 | 0 | 1;

export interface TouchState {
  steer: number;
  throttle: number;
  brake: number;
}

const KEYMAP = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown', 'Space'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  attackLeft: ['KeyQ', 'Comma', 'KeyZ'],
  attackRight: ['KeyE', 'Period', 'KeyC'],
  attackAuto: ['KeyF', 'KeyJ', 'ShiftLeft'],
} as const;

export class InputManager {
  private readonly held = new Set<string>();
  /** Attack directions queued this frame; 0 means "pick a side for me". */
  private pendingAttacks: AttackSide[] = [];
  private touch: TouchState = { steer: 0, throttle: 0, brake: 0 };
  private gamepadIndex: number | null = null;
  private prevGamepadButtons: boolean[] = [];
  private disposed = false;

  onPause: (() => void) | null = null;
  onMute: (() => void) | null = null;
  onAnyKey: (() => void) | null = null;

  /**
   * True while the player is typing into a field.
   *
   * The game binds single letters - P pauses, M mutes - and swallows them
   * with preventDefault, so without this check a rider name could not contain
   * a P and a room code could not be typed at all.
   */
  private static isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Let the browser keep its own shortcuts (reload, devtools, ...).
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Typing beats driving: leave the keystroke to the field.
    if (InputManager.isTyping(e.target)) return;
    if (e.code === 'Escape' || e.code === 'KeyP') {
      e.preventDefault();
      this.onPause?.();
      return;
    }
    if (e.code === 'KeyM') {
      this.onMute?.();
      return;
    }
    if (!e.repeat) {
      if (KEYMAP.attackLeft.includes(e.code as never)) this.pendingAttacks.push(-1);
      else if (KEYMAP.attackRight.includes(e.code as never)) this.pendingAttacks.push(1);
      else if (KEYMAP.attackAuto.includes(e.code as never)) this.pendingAttacks.push(0);
      this.onAnyKey?.();
    }
    // Arrows and space scroll the page otherwise.
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    this.held.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  /** Nothing is held while a field has focus, so the bike does not run on. */
  private readonly onFocusIn = (e: FocusEvent): void => {
    if (InputManager.isTyping(e.target)) {
      this.held.clear();
      this.touch = { steer: 0, throttle: 0, brake: 0 };
    }
  };

  private readonly onBlur = (): void => {
    this.held.clear();
    this.touch = { steer: 0, throttle: 0, brake: 0 };
  };

  private readonly onGamepadConnected = (e: GamepadEvent): void => {
    this.gamepadIndex = e.gamepad.index;
  };

  private readonly onGamepadDisconnected = (e: GamepadEvent): void => {
    if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = null;
  };

  constructor(target: Window = window) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('focusin', this.onFocusIn as EventListener);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('gamepadconnected', this.onGamepadConnected as EventListener);
    target.addEventListener('gamepaddisconnected', this.onGamepadDisconnected as EventListener);
  }

  private anyHeld(codes: readonly string[]): boolean {
    for (const c of codes) if (this.held.has(c)) return true;
    return false;
  }

  setTouch(state: Partial<TouchState>): void {
    this.touch = { ...this.touch, ...state };
  }

  queueAttack(side: AttackSide): void {
    this.pendingAttacks.push(side);
  }

  /** Drain queued attacks. Call once per frame. */
  consumeAttacks(): AttackSide[] {
    if (!this.pendingAttacks.length) return [];
    const out = this.pendingAttacks;
    this.pendingAttacks = [];
    return out;
  }

  private pollGamepad(input: RacerInput): void {
    if (this.gamepadIndex == null || !navigator.getGamepads) return;
    const pad = navigator.getGamepads()[this.gamepadIndex];
    if (!pad) return;

    const stick = pad.axes[0] ?? 0;
    if (Math.abs(stick) > 0.12) input.steer += stick;

    const rt = pad.buttons[7]?.value ?? 0;
    const lt = pad.buttons[6]?.value ?? 0;
    if (rt > 0.05) input.throttle = Math.max(input.throttle, rt);
    if (lt > 0.05) input.brake = Math.max(input.brake, lt);
    if (pad.buttons[0]?.pressed) input.throttle = 1;

    // Shoulder buttons punch; edge-detect so holding does not spam swings.
    const edges: [number, AttackSide][] = [[4, -1], [5, 1], [2, -1], [1, 1]];
    for (const [index, side] of edges) {
      const pressed = pad.buttons[index]?.pressed ?? false;
      if (pressed && !this.prevGamepadButtons[index]) this.pendingAttacks.push(side);
      this.prevGamepadButtons[index] = pressed;
    }
  }

  /** Build this frame's input. */
  sample(): RacerInput {
    const input: RacerInput = {
      throttle: 0,
      brake: 0,
      steer: 0,
      attackLeft: false,
      attackRight: false,
    };

    if (this.anyHeld(KEYMAP.throttle)) input.throttle = 1;
    if (this.anyHeld(KEYMAP.brake)) input.brake = 1;
    if (this.anyHeld(KEYMAP.left)) input.steer -= 1;
    if (this.anyHeld(KEYMAP.right)) input.steer += 1;

    input.throttle = Math.max(input.throttle, this.touch.throttle);
    input.brake = Math.max(input.brake, this.touch.brake);
    input.steer += this.touch.steer;

    this.pollGamepad(input);

    input.steer = clamp(input.steer, -1, 1);
    input.throttle = clamp(input.throttle, 0, 1);
    input.brake = clamp(input.brake, 0, 1);
    return input;
  }

  dispose(target: Window = window): void {
    if (this.disposed) return;
    this.disposed = true;
    target.removeEventListener('keydown', this.onKeyDown);
    target.removeEventListener('focusin', this.onFocusIn as EventListener);
    target.removeEventListener('keyup', this.onKeyUp);
    target.removeEventListener('blur', this.onBlur);
    target.removeEventListener('gamepadconnected', this.onGamepadConnected as EventListener);
    target.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected as EventListener);
  }
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InputManager } from '../../src/input/input';

/** A stand-in for window that records what got bound. */
function fakeWindow() {
  const listeners = new Map<string, EventListener[]>();
  return {
    addEventListener(type: string, fn: EventListener) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type: string, fn: EventListener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    fire(type: string, event: unknown) {
      for (const fn of listeners.get(type) ?? []) fn(event as Event);
    },
  };
}

const key = (code: string, target: unknown = null) => ({
  code,
  target,
  repeat: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  preventDefault() { (this as { prevented?: boolean }).prevented = true; },
});

const textField = { tagName: 'INPUT', isContentEditable: false };

let win: ReturnType<typeof fakeWindow>;
let input: InputManager;

beforeEach(() => {
  win = fakeWindow();
  input = new InputManager(win as unknown as Window);
});
afterEach(() => input.dispose(win as unknown as Window));

describe('driving keys', () => {
  it('reads the throttle', () => {
    win.fire('keydown', key('KeyW'));
    expect(input.sample().throttle).toBe(1);
  });

  it('releases it again', () => {
    win.fire('keydown', key('KeyW'));
    win.fire('keyup', { code: 'KeyW' });
    expect(input.sample().throttle).toBe(0);
  });
});

describe('typing into a field beats driving', () => {
  it('leaves P to the field instead of pausing', () => {
    // P pauses the game and is swallowed with preventDefault, which meant a
    // room code could not be typed and a rider name could not contain a P.
    let paused = false;
    input.onPause = () => { paused = true; };

    const e = key('KeyP', textField);
    win.fire('keydown', e);

    expect(paused).toBe(false);
    expect((e as { prevented?: boolean }).prevented).toBeUndefined();
  });

  it('still pauses when the field does not have focus', () => {
    let paused = false;
    input.onPause = () => { paused = true; };
    win.fire('keydown', key('KeyP'));
    expect(paused).toBe(true);
  });

  it('leaves M to the field instead of muting', () => {
    let muted = false;
    input.onMute = () => { muted = true; };
    win.fire('keydown', key('KeyM', textField));
    expect(muted).toBe(false);
  });

  it('does not drive the bike while typing', () => {
    // Otherwise typing your name would hold the throttle down.
    win.fire('keydown', key('KeyW', textField));
    expect(input.sample().throttle).toBe(0);
  });

  it('lets a space through to the field', () => {
    const e = key('Space', textField);
    win.fire('keydown', e);
    expect((e as { prevented?: boolean }).prevented).toBeUndefined();
  });

  it('drops anything held when a field takes focus', () => {
    // Otherwise the bike runs on at full throttle while you type.
    win.fire('keydown', key('KeyW'));
    expect(input.sample().throttle).toBe(1);
    win.fire('focusin', { target: textField });
    expect(input.sample().throttle).toBe(0);
  });
});

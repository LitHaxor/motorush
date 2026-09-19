import { describe, it, expect } from 'vitest';
import {
  MAX_NAME,
  generateRiderName,
  initialRiderName,
  loadRiderName,
  normaliseRiderName,
  saveRiderName,
  type NameStore,
} from '../../src/ui/ridername';

/** An in-memory stand-in for localStorage. */
function fakeStore(seed: Record<string, string> = {}): NameStore {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

/** A browser that refuses storage outright, as a private window does. */
const hostileStore: NameStore = {
  getItem() { throw new DOMException('denied'); },
  setItem() { throw new DOMException('denied'); },
};

describe('rider name: normalising', () => {
  it('upper-cases and trims', () => {
    expect(normaliseRiderName('  rusty jake  ')).toBe('RUSTY JAKE');
  });

  it('collapses runs of whitespace', () => {
    expect(normaliseRiderName('rust\t\n  jake')).toBe('RUST JAKE');
  });

  it('clamps to the field length', () => {
    const long = normaliseRiderName('x'.repeat(40));
    expect(long).toHaveLength(MAX_NAME);
  });

  it('never exceeds what the database rules accept', () => {
    // The rules cap a name at 16; the field is stricter at 12. If someone
    // raises MAX_NAME past 16, every join would start failing server-side.
    expect(MAX_NAME).toBeLessThanOrEqual(16);
  });

  it('reduces a blank entry to nothing rather than whitespace', () => {
    expect(normaliseRiderName('   ')).toBe('');
  });
});

describe('rider name: generating', () => {
  it('produces a usable name', () => {
    const name = generateRiderName(() => 0.5);
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(MAX_NAME);
    expect(name).toBe(name.toUpperCase());
  });

  it('stays inside the length cap at either end of the table', () => {
    for (const r of [0, 0.999999]) {
      expect(generateRiderName(() => r).length).toBeLessThanOrEqual(MAX_NAME);
      expect(generateRiderName(() => r).length).toBeGreaterThan(0);
    }
  });
});

describe('rider name: remembering', () => {
  it('round-trips through storage', () => {
    const store = fakeStore();
    saveRiderName('rusty jake', store);
    expect(loadRiderName(store)).toBe('RUSTY JAKE');
  });

  it('returns the normalised form it stored', () => {
    expect(saveRiderName('  bone hogg ', fakeStore())).toBe('BONE HOGG');
  });

  it('reports nothing stored rather than an empty name', () => {
    expect(loadRiderName(fakeStore())).toBeNull();
    expect(loadRiderName(fakeStore({ 'motorush.riderName': '   ' }))).toBeNull();
  });

  it('declines to store a blank', () => {
    const store = fakeStore();
    saveRiderName('   ', store);
    expect(loadRiderName(store)).toBeNull();
  });

  it('survives a browser that refuses storage', () => {
    // Private windows throw on access. Not being remembered is acceptable;
    // not being able to race is not.
    expect(() => saveRiderName('rust jake', hostileStore)).not.toThrow();
    expect(saveRiderName('rust jake', hostileStore)).toBe('RUST JAKE');
    expect(loadRiderName(hostileStore)).toBeNull();
  });

  it('copes with storage being unavailable entirely', () => {
    expect(loadRiderName(null)).toBeNull();
    expect(saveRiderName('rust jake', null)).toBe('RUST JAKE');
  });
});

describe('rider name: what the field starts as', () => {
  it('prefers the remembered name', () => {
    const store = fakeStore({ 'motorush.riderName': 'BONE HOGG' });
    expect(initialRiderName(store, () => 0.5)).toBe('BONE HOGG');
  });

  it('falls back to a generated one', () => {
    const name = initialRiderName(fakeStore(), () => 0.5);
    expect(name.length).toBeGreaterThan(0);
  });

  it('still gives a name when storage is dead', () => {
    expect(initialRiderName(hostileStore, () => 0.5).length).toBeGreaterThan(0);
  });
});

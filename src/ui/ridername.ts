// The rider name is the only identity the game keeps. There are no accounts,
// so it lives in this browser and nowhere else - it exists so other riders see
// "BONEYARD JAKE" rather than "PLAYER 2", not to prove who anyone is. Names are
// neither unique nor reserved, which is fine for casual play with no ladder.

/** Matches the maxlength on #rider-name, and sits inside the 16 the database rules allow. */
export const MAX_NAME = 12;

const KEY = 'motorush.riderName';

const FIRST = [
  'RUST', 'BONE', 'IRON', 'ASH', 'GRIT', 'DUST', 'NITRO', 'SMOKE',
  'RAZOR', 'CINDER', 'BRUISE', 'THORN',
];
const SECOND = [
  'JAKE', 'HOGG', 'REED', 'VANCE', 'KANE', 'MOSS', 'DRAKE', 'WOLFE',
  'FOX', 'SLADE', 'BURNS', 'CROW',
];

/**
 * A Storage-shaped thing. Taken as a parameter rather than reached for
 * directly so the behaviour is testable without a browser, and so a page
 * running where storage is unavailable degrades instead of throwing.
 */
export interface NameStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage if this page is allowed it, otherwise nothing. */
export function browserStore(): NameStore | null {
  try {
    // Private windows and blocked site-data make the *accessor* throw, not
    // just the call, so touching it at all has to be guarded.
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Trim, collapse runs of spaces, upper-case, clamp. Always safe to display. */
export function normaliseRiderName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toUpperCase().slice(0, MAX_NAME);
}

/** A throwaway name so the field is never empty and nobody is forced to think. */
export function generateRiderName(rand: () => number = Math.random): string {
  const a = FIRST[Math.floor(rand() * FIRST.length) % FIRST.length];
  const b = SECOND[Math.floor(rand() * SECOND.length) % SECOND.length];
  return normaliseRiderName(`${a} ${b}`);
}

/** The name this browser last raced under, or null if there isn't a usable one. */
export function loadRiderName(store: NameStore | null = browserStore()): string | null {
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const name = normaliseRiderName(raw);
  return name.length > 0 ? name : null;
}

/**
 * Remember the name for next time. Returns what was actually stored so the
 * caller can use the normalised form. Storage failures are swallowed: not
 * being remembered is a far better outcome than not being able to race.
 */
export function saveRiderName(raw: string, store: NameStore | null = browserStore()): string {
  const name = normaliseRiderName(raw);
  if (!store || name.length === 0) return name;
  try {
    store.setItem(KEY, name);
  } catch {
    /* quota, private mode, blocked site data - all non-fatal */
  }
  return name;
}

/** What the name field should start life showing. */
export function initialRiderName(
  store: NameStore | null = browserStore(),
  rand: () => number = Math.random,
): string {
  return loadRiderName(store) ?? generateRiderName(rand);
}

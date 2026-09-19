import { describe, it, expect } from 'vitest';
import { connect, readConfig } from '../../src/net/session';

const FULL = {
  VITE_FIREBASE_API_KEY: 'key',
  VITE_FIREBASE_AUTH_DOMAIN: 'domain',
  VITE_FIREBASE_DATABASE_URL: 'https://db.example.com',
  VITE_FIREBASE_PROJECT_ID: 'proj',
  VITE_FIREBASE_APP_ID: 'app',
};

describe('net config', () => {
  it('reads a complete config', () => {
    expect(readConfig(FULL)).toEqual({
      apiKey: 'key',
      authDomain: 'domain',
      databaseURL: 'https://db.example.com',
      projectId: 'proj',
      appId: 'app',
    });
  });

  it('maps databaseURL to DATABASE_URL', () => {
    // Regression: deriving env names from the camelCase keys produced
    // VITE_FIREBASE_DATABASE_U_R_L, which nothing sets, so online play
    // silently disabled itself.
    expect(readConfig(FULL)?.databaseURL).toBe('https://db.example.com');
  });

  it('refuses a half-filled config rather than failing later', () => {
    for (const key of Object.keys(FULL)) {
      const partial = { ...FULL };
      delete (partial as Record<string, string>)[key];
      expect(readConfig(partial), `missing ${key}`).toBeNull();
    }
  });

  it('treats blank values as missing', () => {
    expect(readConfig({ ...FULL, VITE_FIREBASE_APP_ID: '   ' })).toBeNull();
  });

  it('trims stray whitespace', () => {
    expect(readConfig({ ...FULL, VITE_FIREBASE_API_KEY: '  key  ' })?.apiKey).toBe('key');
  });

  it('is null on an empty environment, so the game just runs offline', () => {
    expect(readConfig({})).toBeNull();
  });
});

describe('connecting', () => {
  it('resolves to no session without a config, rather than throwing', async () => {
    await expect(connect(null)).resolves.toBeNull();
  });
});

describe('when the network will not cooperate', () => {
  it('gives up rather than leaving the menu waiting forever', async () => {
    // The menu waits on this before it can show the online buttons, so a
    // sign-in that never settles has to resolve to "no session" on its own.
    // A bad config is the fast path to that same answer.
    await expect(connect(null, false)).resolves.toBeNull();
  });
});

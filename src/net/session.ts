// Getting online: config, anonymous sign-in, and a Database handle.
//
// Everything here is allowed to fail. Online is an enhancement to a game that
// is complete without it, so a missing config, a blocked network or a refused
// sign-in all resolve to "no session" and the race goes ahead against bots.

import { type FirebaseApp, initializeApp } from 'firebase/app';
import { type Auth, connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { type Database, connectDatabaseEmulator, getDatabase } from 'firebase/database';

/**
 * Local emulator ports, matching firebase.json.
 *
 * Pointing the game at these is what lets an end-to-end match run against a
 * throwaway backend instead of the real project - a test that opens rooms on
 * production would both pollute it and fail the moment the network hiccups.
 */
const EMULATOR = {
  host: '127.0.0.1',
  authPort: 9099,
  databasePort: 9000,
  /**
   * Must match the --project the emulator was started with.
   *
   * The emulator serves many namespaces but only applies firebase.json's rules
   * - and its indexes - to the project's DEFAULT one. Keeping the production
   * databaseURL put the game in a namespace with neither, so every
   * orderByChild query failed with "Index not defined" and matchmaking
   * silently hosted a new room instead of finding the existing one.
   */
  projectId: 'demo-motorush',
};

/** Rewrite the config so it addresses the emulator's default namespace. */
function forEmulator(config: NetConfig): NetConfig {
  return {
    ...config,
    projectId: EMULATOR.projectId,
    databaseURL: `https://${EMULATOR.projectId}-default-rtdb.firebaseio.com`,
  };
}

export interface NetConfig {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  appId: string;
}

export interface NetSession {
  app: FirebaseApp;
  auth: Auth;
  db: Database;
  uid: string;
}

/**
 * Spelled out rather than derived from the key names: a camelCase-to-SCREAMING
 * transform turns `databaseURL` into DATABASE_U_R_L, which silently reads an
 * env var nobody sets.
 */
const ENV_KEYS: Record<keyof NetConfig, string> = {
  apiKey: 'VITE_FIREBASE_API_KEY',
  authDomain: 'VITE_FIREBASE_AUTH_DOMAIN',
  databaseURL: 'VITE_FIREBASE_DATABASE_URL',
  projectId: 'VITE_FIREBASE_PROJECT_ID',
  appId: 'VITE_FIREBASE_APP_ID',
};

/**
 * Pull the config out of Vite's env. Returns null unless every key is present,
 * because a half-filled config fails later and more confusingly than not
 * having one at all.
 *
 * These values are not secrets - they ship in the bundle by design, and access
 * is controlled by database.rules.json.
 */
export function readConfig(env: Record<string, unknown>): NetConfig | null {
  const out = {} as NetConfig;
  for (const [key, envName] of Object.entries(ENV_KEYS) as Array<[keyof NetConfig, string]>) {
    const raw = env[envName];
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    out[key] = raw.trim();
  }
  return out;
}

/**
 * Sign in anonymously and hand back a usable session, or null if we cannot.
 *
 * Anonymous rather than Google: there is no progression to protect, so an
 * account would guard nothing while costing a consent screen between the link
 * and the race. The uid is per-browser and disposable; the rider name is the
 * identity anyone actually sees.
 */
export async function connect(
  config: NetConfig | null,
  useEmulator = false,
): Promise<NetSession | null> {
  if (!config) return null;
  try {
    const app = initializeApp(useEmulator ? forEmulator(config) : config);
    const auth = getAuth(app);
    const db = getDatabase(app);

    if (useEmulator) {
      connectAuthEmulator(auth, `http://${EMULATOR.host}:${EMULATOR.authPort}`, {
        disableWarnings: true,
      });
      connectDatabaseEmulator(db, EMULATOR.host, EMULATOR.databasePort);
    }

    const cred = await signInAnonymously(auth);
    return { app, auth, db, uid: cred.user.uid };
  } catch {
    // Auth not enabled, offline, blocked by an extension - all the same to us.
    return null;
  }
}

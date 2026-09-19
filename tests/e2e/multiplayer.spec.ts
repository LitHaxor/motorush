// A whole online match, end to end: three riders come in through three
// different doors, the owner drops the flag, and everybody races the same
// track together.
//
// Runs against the local Firebase emulator (see playwright.config.ts), so it
// never touches the real project and needs no network.

import { type APIRequestContext, type Browser, type Page, expect, test } from '@playwright/test';
import type {} from '../../src/main';

// Online is the default; the flag here only points it at the local emulator.
const ONLINE = '/?emulator=1';

/**
 * Every rider is a whole browser running a software-GL WebGL scene, and a
 * match needs two or three of them at once. Running these in parallel with
 * each other starves the game loops badly enough that boot never finishes, so
 * the whole file goes one test at a time and allows generously for startup.
 */
const BOOT_TIMEOUT = 150_000;

/** Seats fill from the back of the grid, so the first rider in takes this one. */
const FIRST_SEAT = 7;

/**
 * Wipe the emulator between tests.
 *
 * Rooms outlive a test run, and Quick Match only looks at the first handful of
 * open rooms - so leftovers from an earlier run meant the second rider was
 * matched into a dead room instead of their partner's. `Bearer owner` is the
 * emulator's admin token; it does not exist on the real thing.
 */
async function wipeRooms(request: APIRequestContext): Promise<void> {
  // The namespace the game actually writes to - the emulator's default one
  // for this project, which is also the only namespace its rules apply to.
  await request.delete('http://127.0.0.1:9000/.json?ns=demo-motorush-default-rtdb', {
    headers: { Authorization: 'Bearer owner' },
  });
}

/**
 * Riders opened by the current test, so they can be shut afterwards.
 *
 * They do not close themselves. Each one is a full software-GL WebGL race
 * that keeps running after its test ends, and three of those left spinning in
 * the background starve the next test badly enough that its renderer never
 * finishes booting at all - which shows up as an unrelated timeout two tests
 * later.
 */
const riders: Page[] = [];

/** A browser all of its own, so each rider signs in as a different person. */
async function openRider(browser: Browser, name: string): Promise<Page> {
  // A fresh context per rider is the whole trick: Firebase persists anonymous
  // auth per origin, so sharing one context would make all three the same uid.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(ONLINE);
  await page.waitForFunction(() => window.motorush?.ready() === true, null, {
    timeout: BOOT_TIMEOUT,
  });
  await page.waitForFunction(() => window.motorush?.mode() === 'menu', null, {
    timeout: BOOT_TIMEOUT,
  });
  // The online doors appear whether or not sign-in has landed yet, and are
  // never disabled: pressing one signs in if it has to, so a rider that got
  // here first simply waits a moment longer on the loading screen.
  await expect(page.locator('#menu-online')).toBeVisible({ timeout: 60_000 });
  // Never bolted shut, whatever the state of the connection: a dead button
  // leaves a player with nothing to try, and pressing one is what starts the
  // next attempt at signing in.
  await expect(page.locator('#btn-quick')).toBeEnabled();
  await expect(page.locator('#btn-join')).toBeEnabled();
  await page.fill('#rider-name', name);
  riders.push(page);
  return page;
}

const inLobby = (page: Page) =>
  page.waitForFunction(() => window.motorush?.mode() === 'lobby', null, { timeout: 30_000 });

const racing = (page: Page) =>
  page.waitForFunction(() => window.motorush?.mode() === 'racing', null, { timeout: 30_000 });

const online = (page: Page) => page.evaluate(() => window.motorush!.online());

const snapshot = (page: Page) =>
  page.evaluate(() => {
    const w = window.motorush!.world()!;
    return {
      seed: w.seed,
      state: w.state,
      localRacerId: w.localRacer.id,
      localRacerName: w.localRacer.name,
      names: w.racers.map((r) => r.name),
      colours: w.racers.map((r) => r.color),
      cars: w.traffic.cars.map((c) => ({ id: c.id, s: Math.round(c.s) })),
    };
  });

test.describe('an online match', () => {
  // One at a time: see BOOT_TIMEOUT above.
  // Ten minutes for the file. Each rider is a full software-GL WebGL scene and
  // a match needs two or three at once, so these are minutes-per-test slow by
  // nature - worth running in their own CI job rather than beside the fast ones.
  test.describe.configure({ mode: 'serial', timeout: 600_000 });

  test.beforeEach(async ({ request }) => {
    await wipeRooms(request);
  });

  test.afterEach(async () => {
    // Shut every rider down, whatever the test did or did not get to. A page
    // closed by the test itself - the host that vanishes - is already gone,
    // so failures here are expected and ignored.
    await Promise.all(riders.map((page) => page.context().close().catch(() => {})));
    riders.length = 0;
  });

  test('three riders join three different ways and race together', async ({ browser }) => {
    const ace = await openRider(browser, 'ACE');
    const bolt = await openRider(browser, 'BOLT');
    const cruz = await openRider(browser, 'CRUZ');

    // --- door one: Quick Match with nobody about, so ACE opens the room ----
    await ace.click('#btn-quick');
    await inLobby(ace);
    const room = await online(ace);
    expect(room?.isHost).toBe(true);
    expect(room?.seat).toBe(FIRST_SEAT);
    const code = (await ace.textContent('#lobby-code'))!.trim();
    expect(code).toMatch(/^[A-HJ-NP-RT-Z2-46-9]{4}$/);
    await expect(ace.locator('#btn-launch')).toBeVisible();

    // --- door two: Quick Match finds the room that is already open ---------
    await bolt.click('#btn-quick');
    await inLobby(bolt);
    const boltRoom = await online(bolt);
    expect(boltRoom?.lobbyId).toBe(room?.lobbyId);
    expect(boltRoom?.seat).toBe(FIRST_SEAT - 1);
    expect(boltRoom?.isHost).toBe(false);
    // Only the owner starts the race.
    await expect(bolt.locator('#btn-launch')).toBeHidden();

    // --- door three: somebody read the code out ---------------------------
    // Typed the way a person types: lower case. Padding it with spaces would
    // only prove that maxlength="4" truncates, since the field caps input at
    // four characters before normalisation ever sees it - whitespace handling
    // is covered in the unit tests instead.
    await cruz.fill('#room-code', code.toLowerCase());
    await cruz.click('#btn-join');
    await inLobby(cruz);
    const cruzRoom = await online(cruz);
    expect(cruzRoom?.lobbyId).toBe(room?.lobbyId);
    expect(cruzRoom?.seat).toBe(FIRST_SEAT - 2);

    // The owner's grid fills in as they arrive, without a refresh.
    await expect(ace.locator('#lobby-grid li')).toHaveCount(8);
    await expect(ace.locator('#lobby-grid li').nth(FIRST_SEAT)).toContainText('ACE');
    await expect(ace.locator('#lobby-grid li').nth(FIRST_SEAT - 1)).toContainText('BOLT');
    await expect(ace.locator('#lobby-grid li').nth(FIRST_SEAT - 2)).toContainText('CRUZ');
    // Seats nobody took are bots, not empty slots to be filled first.
    await expect(ace.locator('#lobby-grid li').nth(0)).toContainText('BOT');

    // --- the owner drops the flag -----------------------------------------
    await ace.click('#btn-launch');
    await Promise.all([racing(ace), racing(bolt), racing(cruz)]);

    const [a, b, c] = await Promise.all([snapshot(ace), snapshot(bolt), snapshot(cruz)]);

    // Everyone rebuilt the identical track from the room's seed.
    expect(b.seed).toBe(a.seed);
    expect(c.seed).toBe(a.seed);

    // Each screen follows its own rider. Getting this wrong pointed every
    // guest's camera at the host's bike, so two players watched one motorcycle.
    expect(a.localRacerId).toBe(FIRST_SEAT);
    expect(b.localRacerId).toBe(FIRST_SEAT - 1);
    expect(c.localRacerId).toBe(FIRST_SEAT - 2);
    expect(a.localRacerName).toBe('ACE');
    expect(b.localRacerName).toBe('BOLT');
    expect(c.localRacerName).toBe('CRUZ');

    // The riders wear their own names on every screen, not the bots' names
    // the field was built with.
    for (const view of [a, b, c]) {
      // Riders pack in from the rear, so they occupy the last three seats.
      expect(view.names.slice(FIRST_SEAT - 2)).toEqual(['CRUZ', 'BOLT', 'ACE']);
    }

    // Nobody shares a colour, and every screen agrees on who is wearing what.
    expect(new Set(a.colours).size).toBe(a.colours.length);
    expect(b.colours).toEqual(a.colours);
    expect(c.colours).toEqual(a.colours);
  });

  test('state and input flow between the riders', async ({ browser }) => {
    const host = await openRider(browser, 'HOST');
    const guest = await openRider(browser, 'GUEST');

    await host.click('#btn-quick');
    await inLobby(host);
    await guest.click('#btn-quick');
    await inLobby(guest);
    await host.click('#btn-launch');
    await Promise.all([racing(host), racing(guest)]);

    // Snapshots reaching the guest is the proof the peer connection is up -
    // the handshake goes through the database, but this does not.
    await guest.waitForFunction(() => (window.motorush!.online()?.buffered ?? 0) > 0, null, {
      timeout: 30_000,
    });

    // ...and the guest's input reaching the host is the proof it runs both ways.
    await host.waitForFunction(
      (seat) => (window.motorush!.online()?.driven ?? []).includes(seat),
      FIRST_SEAT - 1,
      { timeout: 30_000 },
    );

    // Traffic is authoritative too: each browser used to simulate its own
    // cars, so a rival could clip one you could not see.
    await expect
      .poll(async () => {
        const [h, g] = await Promise.all([snapshot(host), snapshot(guest)]);
        if (h.cars.length === 0) return false;
        const byId = new Map(g.cars.map((c) => [c.id, c.s]));
        // Within a car length, which is well inside the interpolation delay.
        return h.cars.every((car) => Math.abs((byId.get(car.id) ?? 1e9) - car.s) < 12);
      }, { timeout: 30_000 })
      .toBe(true);
  });

  test('a guest whose host vanishes is never left stuck', async ({ browser }) => {
    // The failure this whole recovery path exists for. A guest draws the
    // host's world, so when the host went away mid-race the last snapshot was
    // re-applied for ever: the bike sat pinned in the road, every control was
    // dead, and there was no button anywhere that could get out of it.
    const host = await openRider(browser, 'HOST');
    const guest = await openRider(browser, 'GUEST');

    await host.click('#btn-quick');
    await inLobby(host);
    await guest.click('#btn-quick');
    await inLobby(guest);
    await host.click('#btn-launch');
    await Promise.all([racing(host), racing(guest)]);

    // Wait until the guest really is being driven by the host, so what
    // follows is a loss rather than a connection that never worked.
    await guest.waitForFunction(() => (window.motorush!.online()?.buffered ?? 0) > 0, null, {
      timeout: 30_000,
    });

    // The host does not say goodbye - it simply stops existing, which is what
    // a closed tab, a dead battery or a walk into a lift actually looks like.
    await host.context().close();

    // A way out appears, whatever the guest decides to do with it.
    await expect(guest.locator('#screen-link')).toBeVisible({ timeout: 30_000 });
    await expect(guest.locator('#btn-link-continue')).toBeEnabled();

    // And taking it puts them back into a running race rather than at the menu.
    const clockBefore = await guest.evaluate(() => window.motorush!.world()!.elapsed);
    await guest.click('#btn-link-continue');
    await expect(guest.locator('#screen-link')).toBeHidden();
    expect(await guest.evaluate(() => window.motorush!.mode())).toBe('racing');

    // The race clock moving is the proof the loop is running again rather
    // than being held still behind a panel. It only starts once the lights go
    // out, so this also covers a host that vanished during the countdown.
    await expect
      .poll(() => guest.evaluate(() => window.motorush!.world()!.elapsed), { timeout: 30_000 })
      .toBeGreaterThan(clockBefore + 1);

    // And the controls answer, which is the half that was actually broken:
    // hold the throttle and the bike goes. Without a hand on it the bike is
    // quite right to sit there, so the test has to provide one.
    await guest.keyboard.down('KeyW');
    const distanceBefore = await guest.evaluate(() => window.motorush!.world()!.localRacer.s);
    await expect
      .poll(() => guest.evaluate(() => window.motorush!.world()!.localRacer.s), { timeout: 30_000 })
      .toBeGreaterThan(distanceBefore + 1);
    await guest.keyboard.up('KeyW');
  });

  test('a wrong code is refused without leaving the menu', async ({ browser }) => {
    const rider = await openRider(browser, 'LOST');

    await rider.fill('#room-code', 'QQ');
    await rider.click('#btn-join');
    await expect(rider.locator('#online-note')).toHaveText(/four characters/i);

    await rider.fill('#room-code', 'QQQQ');
    await rider.click('#btn-join');
    await expect(rider.locator('#online-note')).toHaveText(/No room with that code/i);
    expect(await rider.evaluate(() => window.motorush!.mode())).toBe('menu');
  });
});

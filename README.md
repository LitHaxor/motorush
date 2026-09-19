# RoadBrush

A Road Rash–style arcade motorcycle combat racer, built with **Three.js**,
**TypeScript** and **Vite**. Eight riders, public roads, and no rules worth
mentioning. Punch your rivals off their bikes, dodge oncoming traffic at
250 km/h, and try not to get pulled over.

![built with Three.js](https://img.shields.io/badge/three.js-r169-black)
![typescript](https://img.shields.io/badge/typescript-strict-3178c6)
![tests](https://img.shields.io/badge/tests-99%20unit%20%2B%2026%20e2e-success)

## Playing

| Action                  | Keyboard         | Gamepad            | Touch          |
| ----------------------- | ---------------- | ------------------ | -------------- |
| Throttle                | `W` / `↑`        | RT or A            | GAS            |
| Brake                   | `S` / `↓`        | LT                 | BRAKE          |
| Steer                   | `A` `D` / `←` `→`| Left stick         | ◀ ▶            |
| Punch left / right      | `Q` / `E`        | LB / RB            | ✊ ✊           |
| Punch nearest rider     | `F`              | —                  | —              |
| Pause                   | `P` / `Esc`      | —                  | —              |
| Mute                    | `M`              | —                  | —              |

**Holeshot:** hold the throttle as the lights go out for a launch boost. Jump
the start and you lose it.

**Going down:** crash and you tumble — how far depends on how fast you were
going. Your rider gets up and runs back to the bike on their own; hold the
throttle to make them hustle.

**The law:** speeding and brawling build *heat*. Max it out and a patrol bike
comes after you. Stay alongside one for two seconds and you're **BUSTED**.
Outrun them by 185 m, or knock them down three times, and they give up.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle into dist/
npm run preview    # serve the built bundle on :4173
```

### Tests

```bash
npm test           # 99 unit tests (headless simulation, node)
npm run coverage   # coverage gate: 80% lines / 75% branches
npm run test:e2e   # 26 Playwright tests, desktop + mobile
npm run test:all   # unit -> build -> e2e
```

## How it's put together

The game is split in two, and the split is the important design decision:

```
src/
├── sim/        Headless simulation. No DOM, no Three.js, no rendering.
│   ├── track.ts      Procedural centreline baked into flat arrays
│   ├── physics.ts    Arcade handling: speed, steering, cornering drift
│   ├── combat.ts     Wind-up → strike → recovery melee
│   ├── traffic.ts    Recycled car pool + collision resolution
│   ├── ai.ts         Rival and police brains
│   └── world.ts      Orchestrator; step(dt, input) → SimEvent[]
├── render/     Three.js layer. Reads sim state, never writes it.
├── audio/      Web Audio synthesis (no sound files)
├── input/      Keyboard, gamepad and touch merged into one input
└── ui/         HUD and screen overlays (plain DOM)
```

Because `sim/` is pure TypeScript with no browser dependencies, the entire game
can be played at thousands of frames per second in Node. That's what makes the
[balance suite](tests/unit/balance.test.ts) possible: it plays 36 complete races
with the AI at the controls and asserts the difficulty curve still holds.

**Track space.** Everything is positioned by `s` (distance along the centreline)
and `lateral` (signed offset from it), converted to world coordinates only at
render time. Collisions, AI lane planning and overtaking logic are all trivial
1-D problems in this space instead of awkward 3-D ones.

**Determinism.** The simulation is seeded (mulberry32) and runs on a fixed
timestep, so a given seed always produces exactly the same race — which is what
lets the tests assert on outcomes rather than on approximations.

**Events, not coupling.** `world.step()` returns a typed `SimEvent[]` union. The
renderer turns those into sparks and camera shake, the audio layer turns them
into sounds, the HUD turns them into text. None of them can affect the sim, and
adding an event type forces every consumer to acknowledge it.

## Performance

- Road, shoulders and terrain are three ribbon meshes generated once per track.
- Trees, rocks, guardrails and lamps are `InstancedMesh` — the whole roadside is
  a handful of draw calls regardless of track length.
- Traffic uses a fixed pool of bodies recycled through a window around the
  player, so draw calls stay constant however long the race runs.
- Quality auto-downgrades (bloom and shadows off, lower pixel ratio) if the
  frame time stays above ~25 ms.

## Deploying

The build is fully static. On Vercel the framework preset is detected from
[`vercel.json`](vercel.json):

```bash
npx vercel --prod
```

## Assets

Every asset is CC0. See [CREDITS.md](CREDITS.md). The bikes, riders, sky, road
markings and all audio are generated at runtime rather than loaded.

### Screen art (optional)

Drop `splash.jpg`, `busted.jpg`, `winner.jpg` and `wasted.jpg` into
[`public/art/`](public/art/) and the matching screens use them as backdrops.
Without them the screens fall back to a gradient treatment that stands on its
own — see [`public/art/README.md`](public/art/README.md).

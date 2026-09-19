import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Software WebGL is CPU-hungry; too many parallel pages starves the game
  // loop and makes real-time assertions flaky.
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    launchOptions: {
      // Headless Chromium needs a software GL backend to run WebGL in CI.
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-lcd-text',
      ],
    },
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
      testIgnore: '**/mobile.spec.ts',
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
      testMatch: '**/mobile.spec.ts',
    },
  ],

  webServer: [
    {
      command: 'npm run build && npm run preview',
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The multiplayer spec races against this rather than the real project:
      // opening rooms on production during a test would both pollute it and
      // fail the moment the network hiccups. A `demo-` project id keeps the
      // emulator fully offline.
      //
      // The pkill is not paranoia. The database emulator is a Java child
      // process that routinely outlives the CLI that started it - an
      // interrupted run leaves it holding port 9000 while auth, which is what
      // the health check below looks at, is gone. Every later run then fails
      // to start with "port taken" and no test can be run at all until
      // somebody finds the stray process by hand. This only ever runs when
      // the health check has already said no usable emulator is up, so a
      // healthy one is reused rather than killed.
      command:
        'pkill -f firebase-database-emulator; pkill -f "firebase emulators:start"; '
        + 'npx firebase emulators:start --only database,auth --project demo-motorush',
      url: 'http://127.0.0.1:9099/',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});

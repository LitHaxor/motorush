import { defineConfig } from 'vitest/config';

// These tests talk to the Realtime Database emulator, so they are kept out of
// `npm test` (which stays pure and offline) and run via `npm run test:emulator`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rules/**/*.test.ts', 'tests/net/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});

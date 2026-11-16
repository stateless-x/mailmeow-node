import { defineConfig } from 'vitest/config';

// Run through `bun run test:contract`, which starts the throwaway stack and
// exports MAILMEOW_CONTRACT_* first.
export default defineConfig({
  test: {
    include: ['test/contract/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});

import path from 'node:path'
import { defineConfig } from 'vitest/config'

const pkg = (name: string) => path.resolve(__dirname, 'packages', name, 'src')

export default defineConfig({
  resolve: {
    alias: {
      '@yt/core': pkg('core'),
      '@yt/db': pkg('db'),
      '@yt/pipeline': pkg('pipeline'),
      '@yt/providers': pkg('providers'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'test/**/*.test.ts'],
    // The opt-in integration suite is slow and loads a real model — it has its own config
    // (vitest.integration.config.ts) and must never run as part of the default suite.
    exclude: ['**/node_modules/**', 'test/integration/**'],
    environment: 'node',
    restoreMocks: true,
    globalSetup: ['./test/setup/global-db.ts'],
    testTimeout: 20_000,
  },
})

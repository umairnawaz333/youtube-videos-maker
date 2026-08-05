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
    include: ['test/integration/**/*.integration.test.ts'],
    globalSetup: ['./test/setup/global-db.ts'],
    // A local 8B model takes minutes for six stages.
    testTimeout: 900_000,
    hookTimeout: 60_000,
    environment: 'node',
  },
})

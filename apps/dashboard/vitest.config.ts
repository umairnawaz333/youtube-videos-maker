import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Deliberately its own config, scoped to this package only. The root suite
// (`pnpm test` at the repo root) has its own vitest.config.ts whose `include` does not
// reach `apps/**`, so these tests never run as part of it and never need to — see the
// dashboard build report for how to run this suite on its own.
export default defineConfig({
  resolve: {
    alias: {
      '@yt/core': path.resolve(__dirname, '../../packages/core/src'),
      '@yt/db': path.resolve(__dirname, '../../packages/db/src'),
      '@yt/pipeline': path.resolve(__dirname, '../../packages/pipeline/src'),
      '@yt/providers': path.resolve(__dirname, '../../packages/providers/src'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
})

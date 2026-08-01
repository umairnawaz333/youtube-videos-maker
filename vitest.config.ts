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
    environment: 'node',
    restoreMocks: true,
  },
})

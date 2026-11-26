import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'jsdom',
    testTimeout: 15_000,
    include: ['src/**/*.dom.test.tsx'],
    setupFiles: ['src/renderer/src/test/setupDom.ts'],
    restoreMocks: true,
    clearMocks: true
  }
})

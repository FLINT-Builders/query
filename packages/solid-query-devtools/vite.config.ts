import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

import packageJson from './package.json'

const transitionGroupStub = fileURLToPath(
  new URL('./src/__tests__/transitionGroupStub.js', import.meta.url),
)

export default defineConfig({
  plugins: [solid()],
  // fix from https://github.com/vitest-dev/vitest/issues/6992#issuecomment-2509408660
  resolve: {
    alias: {
      // solid-transition-group's dependency export map does not resolve in
      // Vitest. The stub renders children with no animation.
      'solid-transition-group': transitionGroupStub,
    },
    conditions: ['@tanstack/custom-condition'],
  },
  environments: {
    ssr: {
      resolve: {
        alias: {
          'solid-transition-group': transitionGroupStub,
        },
        conditions: ['@tanstack/custom-condition'],
      },
    },
  },
  test: {
    name: packageJson.name,
    dir: './src',
    watch: false,
    environment: 'jsdom',
    setupFiles: ['test-setup.ts'],
    coverage: {
      enabled: !!process.env.CI,
      provider: 'istanbul',
      include: ['src/**/*'],
      exclude: ['src/__tests__/**'],
    },
    typecheck: { enabled: true },
    restoreMocks: true,
  },
})

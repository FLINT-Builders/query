import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'
import { svelteTesting } from '@testing-library/svelte/vite'
import solid from '../query-devtools/node_modules/vite-plugin-solid/dist/esm/index.mjs'

import packageJson from './package.json'

const devtoolsModules = fileURLToPath(
  new URL('../query-devtools/node_modules/', import.meta.url),
)
const solidRoot = path.join(devtoolsModules, 'solid-js')

// @tanstack/query-devtools is a Solid app. Its packages are installed on that
// workspace package, not on this one, so the panel cannot be mounted from this
// Vitest project until those imports resolve. solid-js entry points are pinned
// to one client build so the panel's signals and renderer are the same copy.
const devtoolsAliases = [
  {
    find: /^solid-js\/web$/,
    replacement: path.join(solidRoot, 'web/dist/dev.js'),
  },
  {
    find: /^solid-js\/store$/,
    replacement: path.join(solidRoot, 'store/dist/dev.js'),
  },
  {
    find: /^solid-js\/h$/,
    replacement: path.join(solidRoot, 'h/dist/h.js'),
  },
  {
    find: /^solid-js$/,
    replacement: path.join(solidRoot, 'dist/dev.js'),
  },
  ...[
    'solid-transition-group',
    'goober',
    'clsx',
    'superjson',
    '@kobalte/core',
    '@solid-primitives/storage',
    '@solid-primitives/keyed',
    '@solid-primitives/resize-observer',
    '@tanstack/match-sorter-utils',
  ].map((name) => ({
    find: name,
    replacement: path.join(devtoolsModules, name),
  })),
]

export default defineConfig({
  plugins: [solid(), svelte(), svelteTesting()],
  // fix from https://github.com/vitest-dev/vitest/issues/6992#issuecomment-2509408660
  resolve: {
    alias: devtoolsAliases,
    conditions: ['@tanstack/custom-condition'],
  },
  environments: {
    ssr: {
      resolve: {
        conditions: ['@tanstack/custom-condition'],
      },
    },
  },
  test: {
    name: packageJson.name,
    dir: './tests',
    watch: false,
    environment: 'jsdom',
    setupFiles: ['./tests/test-setup.ts'],
    coverage: {
      enabled: !!process.env.CI,
      provider: 'istanbul',
      include: ['src/**/*'],
    },
    typecheck: { enabled: true },
  },
})

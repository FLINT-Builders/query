import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from './vite.config'

/**
 * Mounting the devtools panel loads `@tanstack/query-devtools`. The package
 * vite config resolves that dependency to TypeScript source, which Vitest
 * then runs with Solid's server runtime. Point the tests at the browser
 * build of this commit so the panel that renders is the one the package ships.
 */
const queryDevtoolsBrowserBuild = fileURLToPath(
  new URL('../query-devtools/build/dev.js', import.meta.url),
)

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        '@tanstack/query-devtools': queryDevtoolsBrowserBuild,
      },
    },
  }),
)

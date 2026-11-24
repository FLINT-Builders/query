import solid from 'vite-plugin-solid'
import { defineConfig } from 'vitest/config'

const conditions = ['@tanstack/custom-condition', 'node', 'import']

export default defineConfig({
  plugins: [solid({ ssr: true, dev: false, hot: false })],
  resolve: {
    conditions,
  },
  ssr: {
    external: ['solid-js'],
    resolve: {
      conditions,
    },
  },
  test: {
    environment: 'node',
    include: ['src/__tests__/ssrErrorDisclosure.test.tsx'],
  },
})

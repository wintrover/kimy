import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'kimi-core',
    include: ['test/**/*.{test,e2e}.ts'],
    pool: 'threads',
    testTimeout: 10000,
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: [
            '@moonshot-ai/kosong',
            '@moonshot-ai/kaos',
            '@moonshot-ai/protocol',
          ],
        },
      },
    },
  },
})

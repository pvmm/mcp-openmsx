import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include: ['tests/**/*.test.ts'],
    coverage: {
      reporter: [
        ['text', { maxCols: 160 }],
        'text-summary',
        'html',
        'clover',
        'json',
      ],
    },
  },
});

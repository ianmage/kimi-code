import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'forum-link',
    include: ['test/**/*.test.ts'],
  },
});

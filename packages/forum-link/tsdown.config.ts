import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: { index: './src/index.ts' },
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  dts: false,
  plugins: [rawTextPlugin()],
  deps: {
    alwaysBundle: [/^zod$/],
  },
});

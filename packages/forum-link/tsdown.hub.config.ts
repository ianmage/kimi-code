import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: { hub: './src/hub/main.ts' },
  format: ['esm'],
  outDir: 'dist',
  clean: false,
  dts: false,
  outputOptions: {
    codeSplitting: false,
  },
  plugins: [rawTextPlugin()],
  deps: {
    alwaysBundle: [/^zod$/],
  },
});

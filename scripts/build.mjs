import {chmod, readFile} from 'node:fs/promises';
import {build} from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  jsx: 'automatic',
  // Installed alongside the CLI by npm rather than bundled.
  external: Object.keys(pkg.dependencies ?? {}),
  banner: {js: '#!/usr/bin/env node'},
  logLevel: 'info',
});

await chmod('dist/cli.js', 0o755);

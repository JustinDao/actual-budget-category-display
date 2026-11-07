import { build } from 'esbuild';

await Promise.all([
  build({
    entryPoints: ['src/client.ts'],
    outfile: 'client.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
  }),
  build({
    entryPoints: ['scripts/plaid-link-client.ts'],
    outfile: '.build/plaid-link-client.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
  }),
]);

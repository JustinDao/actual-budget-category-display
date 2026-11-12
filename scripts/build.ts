import { build } from 'esbuild';

try {
  process.loadEnvFile?.('.env.local');
} catch {
  // .env.local is optional (e.g. on Vercel builds)
}

const authRequired = Boolean((process.env.APP_PASSWORD || '').trim());

await Promise.all([
  build({
    entryPoints: ['src/client.ts'],
    outfile: 'client.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    define: {
      __AUTH_REQUIRED__: JSON.stringify(authRequired),
    },
  }),
  build({
    entryPoints: ['scripts/plaid-link-client.ts'],
    outfile: '.build/plaid-link-client.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
  }),
]);

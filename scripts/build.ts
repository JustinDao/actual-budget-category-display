import { createHash } from 'node:crypto';
import { build } from 'esbuild';

try {
  process.loadEnvFile('.env.local');
} catch {
  // .env.local is optional (e.g. in CI / Vercel builds)
}

const rawPassword = (process.env.APP_PASSWORD || '').trim();
const appPasswordHash = rawPassword
  ? createHash('sha256').update(rawPassword, 'utf8').digest('hex')
  : '';

await Promise.all([
  build({
    entryPoints: ['src/client.ts'],
    outfile: 'client.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    define: {
      __APP_PASSWORD_HASH__: JSON.stringify(appPasswordHash),
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

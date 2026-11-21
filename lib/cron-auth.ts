import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Verifies Vercel Cron / bearer-authenticated requests using constant-time
 * comparison. Fails closed if CRON_SECRET is unset or empty.
 */
export function verifyCronAuth(request: Request): boolean {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) {
    return false;
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const providedToken = authHeader.slice(7).trim();
  if (!providedToken) {
    return false;
  }

  return timingSafeEqual(sha256(providedToken), sha256(secret));
}

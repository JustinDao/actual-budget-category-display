/**
 * Vercel Serverless Function: /api/auth
 *
 * - POST /api/auth: Verifies a client-side SHA-256 pre-hashed password (`clientHash`)
 *   against the server-only `APP_PASSWORD` using `scryptSync` + `timingSafeEqual`.
 *   Issues a signed, expiring HMAC-SHA256 session token so passwords and hashes are
 *   never baked into the public frontend JavaScript bundle.
 *
 * - GET /api/auth: Validates an existing `x-app-auth` session token on page reload.
 */

import { createHash, createHmac, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

export function getConfiguredPassword(): string {
  return (process.env.APP_PASSWORD || '').trim();
}

function derivePasswordKeys(configuredPassword: string): {
  expectedVerifier: Buffer;
  salt: Buffer;
  signingKey: Buffer;
} {
  const expectedClientHash = createHash('sha256')
    .update(configuredPassword, 'utf8')
    .digest('hex');
  const salt = createHash('sha256')
    .update(`ab-auth-salt-v1:${configuredPassword}`, 'utf8')
    .digest();
  const expectedVerifier = scryptSync(expectedClientHash, salt, 32);
  const signingKey = scryptSync(
    expectedClientHash,
    'ab-session-signing-key-v1',
    32,
  );
  return { expectedVerifier, salt, signingKey };
}

export function verifyClientPasswordHash(
  clientHash: unknown,
  configuredPassword: string,
): boolean {
  if (
    typeof clientHash !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(clientHash.trim())
  ) {
    return false;
  }
  const normalized = clientHash.trim().toLowerCase();
  const { expectedVerifier, salt } = derivePasswordKeys(configuredPassword);
  const providedVerifier = scryptSync(normalized, salt, 32);
  return timingSafeEqual(providedVerifier, expectedVerifier);
}

export function createSessionToken(
  configuredPassword: string,
  nowMs = Date.now(),
): string {
  const { signingKey } = derivePasswordKeys(configuredPassword);
  const payload = {
    v: 1,
    iat: nowMs,
    exp: nowMs + SESSION_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const signatureHex = createHmac('sha256', signingKey)
    .update(payloadB64, 'utf8')
    .digest('hex');
  return `${payloadB64}.${signatureHex}`;
}

export function verifySessionToken(
  token: unknown,
  configuredPassword: string,
  nowMs = Date.now(),
): boolean {
  if (typeof token !== 'string' || !token.includes('.')) {
    return false;
  }
  const parts = token.trim().split('.');
  if (parts.length !== 2) {
    return false;
  }
  const [payloadB64, providedSigHex] = parts;
  if (!payloadB64 || !/^[a-f0-9]{64}$/i.test(providedSigHex)) {
    return false;
  }

  const { signingKey } = derivePasswordKeys(configuredPassword);
  const expectedSigBuf = createHmac('sha256', signingKey)
    .update(payloadB64, 'utf8')
    .digest();
  const providedSigBuf = Buffer.from(providedSigHex.toLowerCase(), 'hex');

  if (
    providedSigBuf.length !== expectedSigBuf.length ||
    !timingSafeEqual(providedSigBuf, expectedSigBuf)
  ) {
    return false;
  }

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    );
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('exp' in decoded) ||
      typeof decoded.exp !== 'number' ||
      decoded.exp <= nowMs
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function extractAuthToken(request: Request): string {
  const headerToken = request.headers.get('x-app-auth');
  if (headerToken && headerToken.trim()) {
    return headerToken.trim();
  }
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

export function verifyRequestAuth(request: Request): boolean {
  const configuredPassword = getConfiguredPassword();
  if (!configuredPassword) {
    return true;
  }
  const token = extractAuthToken(request);
  if (!token) {
    return false;
  }
  return verifySessionToken(token, configuredPassword);
}

export async function GET(request: Request): Promise<Response> {
  const configuredPassword = getConfiguredPassword();

  if (!configuredPassword) {
    return Response.json(
      {
        ok: true,
        authenticated: true,
        authRequired: false,
      },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  }

  if (!verifyRequestAuth(request)) {
    return Response.json(
      {
        ok: false,
        authenticated: false,
        authRequired: true,
        error: 'Session expired or invalid. Please unlock the app again.',
      },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  return Response.json(
    {
      ok: true,
      authenticated: true,
      authRequired: true,
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

export async function POST(request: Request): Promise<Response> {
  const configuredPassword = getConfiguredPassword();

  if (!configuredPassword) {
    return Response.json(
      {
        ok: true,
        authenticated: true,
        authRequired: false,
        sessionToken: '',
      },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  }

  let body: { clientHash?: unknown } = {};
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed === 'object' && parsed !== null) {
      body = parsed as { clientHash?: unknown };
    }
  } catch {
    // Fall through to invalid password check
  }

  if (!verifyClientPasswordHash(body.clientHash, configuredPassword)) {
    return Response.json(
      {
        ok: false,
        authenticated: false,
        error: 'Incorrect password.',
      },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const sessionToken = createSessionToken(configuredPassword);
  return Response.json(
    {
      ok: true,
      authenticated: true,
      authRequired: true,
      sessionToken,
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

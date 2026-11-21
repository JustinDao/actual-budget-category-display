import { verifyRequestAuth } from './auth.js';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

async function upstashGet(key: string): Promise<unknown> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error('Upstash Redis is not configured');
  }
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Upstash read failed: ${res.status}`);
  }
  const data = (await res.json()) as { result?: unknown };
  if (typeof data.result !== 'string' || !data.result) {
    return null;
  }
  try {
    return JSON.parse(data.result);
  } catch {
    return JSON.parse(decodeURIComponent(data.result));
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!verifyRequestAuth(request)) {
    return Response.json(
      {
        error: 'Unauthorized: invalid or expired app session.',
        authRequired: true,
      },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const value = await upstashGet('budget:amount');
    if (!value) {
      return Response.json(
        { error: 'No data yet — run /api/sync first' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    return Response.json(value, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error('Failed to load budget data:', error);
    return Response.json(
      { error: 'Failed to load budget data.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

import { errorMessage } from '../lib/errors.js';
import { verifyRequestAuth } from './auth.js';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

async function upstashGet(key: string): Promise<unknown> {
  const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const data = await res.json();
  return data.result ? JSON.parse(decodeURIComponent(data.result)) : null;
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
    return Response.json(
      { error: errorMessage(error) },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

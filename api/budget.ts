import { createHash } from 'node:crypto';
import { errorMessage } from '../lib/errors.js';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function upstashGet(key: string): Promise<unknown> {
  const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const data = await res.json();
  return data.result ? JSON.parse(decodeURIComponent(data.result)) : null;
}

export async function GET(request: Request) {
  const configuredPassword = (process.env.APP_PASSWORD || '').trim();
  if (configuredPassword) {
    const expectedHash = createHash('sha256').update(configuredPassword, 'utf8').digest('hex');
    const providedHash = request.headers.get('x-app-auth') || '';
    if (providedHash !== expectedHash) {
      return Response.json({ error: 'Unauthorized: invalid app password.' }, { status: 401 });
    }
  }

  try {
    const value = await upstashGet('budget:amount');
    if (!value) {
      return Response.json({ error: 'No data yet — run /api/sync first' }, { status: 404 });
    }
    return Response.json(value);
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}

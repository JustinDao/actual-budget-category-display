const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function upstashGet(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const data = await res.json();
  return data.result ? JSON.parse(decodeURIComponent(data.result)) : null;
}

export async function GET() {
  try {
    const value = await upstashGet('budget:amount');
    if (!value) {
      return Response.json({ error: 'No data yet — run /api/sync first' }, { status: 404 });
    }
    return Response.json(value);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

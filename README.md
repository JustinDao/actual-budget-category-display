# actual-budget-sync

Fetches a budgeted amount from Actual Budget (self-hosted, E2E encrypted) once daily
and stores it in Upstash Redis. Exposes a public read endpoint for other apps.

## Setup

### 1. Upstash
- Create a free account at https://upstash.com
- Create a Redis database
- Copy the REST URL and REST token

### 2. Environment variables
Add these in your Vercel project settings → Environment Variables:

| Variable | Description |
|---|---|
| `ACTUAL_SERVER_URL` | Your Pikapods URL, e.g. `https://actual-xxxxx.pikapods.com` |
| `ACTUAL_PASSWORD` | Your Actual server password |
| `ACTUAL_SYNC_ID` | Settings → Advanced → Sync ID in Actual |
| `ACTUAL_ENCRYPTION_PASSWORD` | Your E2E encryption password |
| `BUDGET_CATEGORY_NAME` | Exact category name to track, e.g. `Groceries` |
| `UPSTASH_REDIS_REST_URL` | From Upstash dashboard |
| `UPSTASH_REDIS_REST_TOKEN` | From Upstash dashboard |
| `CRON_SECRET` | Any random string, e.g. `openssl rand -hex 16` |

### 3. vercel.json
Update the `secret` query param in vercel.json to match your `CRON_SECRET`.

### 4. Deploy
```bash
npx vercel
```

## Endpoints

### `GET /api/sync?secret=YOUR_CRON_SECRET`
Triggered daily by Vercel Cron (8am UTC). Fetches from Actual, writes to Upstash.
Also callable manually for testing.

### `GET /api/budget`
Public read endpoint. Returns:
```json
{
  "category": "Groceries",
  "budgeted": 500.00,
  "month": "2026-05",
  "updatedAt": "2026-05-22T08:04:13.000Z"
}
```

## Notes
- Amounts are in dollars (Actual stores as milliunits internally, converted here)
- The cron runs at 8am UTC — Vercel Hobby may fire it anywhere in that hour
- To track multiple categories, duplicate the upstashSet call with different keys
  and add a `/api/budget/[category]` read route

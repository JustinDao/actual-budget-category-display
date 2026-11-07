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
| `HEALTHCHECKS_ACTUAL_URL` | Healthchecks.io ping URL shared by `/api/sync` and `/api/reconcile-investments` |
| `HEALTHCHECKS_BILT_URL` | Healthchecks.io ping URL for `/api/import-bilt` |

Create two checks in Healthchecks.io and add each check's ping URL as the matching
environment variable. Treat these URLs as secrets. The Actual check receives
success pings from either Actual job and failure pings when either job fails; the
Bilt check is independent. Healthchecks sends alerts when a check changes to Down,
so repeated failures while it remains Down do not send another state-change alert.
A success from either Actual job returns the shared check to Up, so this grouping
does not independently detect if only one of the two Actual jobs was skipped.

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

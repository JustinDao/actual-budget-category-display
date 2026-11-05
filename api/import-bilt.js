import * as api from '@actual-app/api'
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'
import { mkdirSync } from 'fs'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// "Bilt Palladium" account in Actual
const ACTUAL_ACCOUNT_ID =
  process.env.BILT_ACTUAL_ACCOUNT_ID || 'fb530a42-7007-4168-a9ca-184a647cf356'

// Optional: restrict to one Plaid account_id if the Item ever exposes more than the card
const PLAID_ACCOUNT_FILTER = process.env.PLAID_ACCOUNT_ID || null

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const CURSOR_KEY = 'plaid:bilt:cursor'

const plaid = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments.production,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  })
)

async function getCursor() {
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(CURSOR_KEY)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  })
  if (!res.ok) throw new Error(`Upstash read failed: ${res.status}`)
  const { result } = await res.json()
  if (!result) return null
  try {
    return JSON.parse(result).cursor ?? null
  } catch {
    return null
  }
}

async function saveCursor(cursor) {
  const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(CURSOR_KEY)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify({ cursor, updatedAt: new Date().toISOString() }),
  })
  if (!res.ok) throw new Error(`Upstash write failed: ${res.status}`)
}

// Pull everything since `startCursor`. If Plaid reports the data changed mid-pagination,
// restart from the original cursor, as their docs instruct.
async function pullFromPlaid(startCursor) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let cursor = startCursor ?? undefined
      const added = []
      const modified = []
      const removed = []
      let hasMore = true

      while (hasMore) {
        const { data } = await plaid.transactionsSync({
          access_token: process.env.PLAID_ACCESS_TOKEN,
          cursor,
          count: 500,
        })
        added.push(...data.added)
        modified.push(...data.modified)
        removed.push(...data.removed)
        cursor = data.next_cursor
        hasMore = data.has_more
      }
      return { added, modified, removed, nextCursor: cursor }
    } catch (err) {
      const code = err?.response?.data?.error_code
      if (code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < 3) continue
      throw err
    }
  }
}

// Plaid: positive = money out of the account (a card purchase), negative = money in
// (payment/refund). Actual: negative = spending. So flip the sign. Actual wants integer cents.
function toActual(t) {
  return {
    account: ACTUAL_ACCOUNT_ID,
    date: t.date, // 'YYYY-MM-DD'
    amount: -Math.round(t.amount * 100),
    payee_name: t.merchant_name || t.name,
    imported_payee: t.name,
    imported_id: t.transaction_id, // stable ID -> Actual dedupes on re-import
    cleared: true,
  }
}

export async function GET(request) {
  // Fail closed if CRON_SECRET is missing. Vercel Cron sends this header automatically.
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const required = [
    'ACTUAL_SERVER_URL',
    'ACTUAL_PASSWORD',
    'ACTUAL_SYNC_ID',
    'PLAID_CLIENT_ID',
    'PLAID_SECRET',
    'PLAID_ACCESS_TOKEN',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
  ]
  const missing = required.filter((k) => !process.env[k])
  if (missing.length) {
    return Response.json({ error: `Missing env vars: ${missing.join(', ')}` }, { status: 500 })
  }

  // ?dry=1 -> show what would be imported, touch nothing, don't advance the cursor
  const dry = new URL(request.url).searchParams.get('dry') === '1'

  let initialized = false
  try {
    const startCursor = await getCursor()
    const { added, modified, removed, nextCursor } = await pullFromPlaid(startCursor)

    const inScope = (t) => !PLAID_ACCOUNT_FILTER || t.account_id === PLAID_ACCOUNT_FILTER

    // Skip pending: they get a different transaction_id once posted, which would duplicate.
    const toImport = [...added, ...modified].filter((t) => inScope(t) && !t.pending).map(toActual)
    const toRemove = removed.filter(inScope)

    if (dry) {
      return Response.json({
        ok: true,
        dry: true,
        startedFromCursor: Boolean(startCursor),
        wouldImport: toImport.length,
        wouldRemove: toRemove.length,
        sample: toImport.slice(0, 10),
      })
    }

    mkdirSync('/tmp/actual-cache', { recursive: true })
    await api.init({
      dataDir: '/tmp/actual-cache',
      serverURL: process.env.ACTUAL_SERVER_URL,
      password: process.env.ACTUAL_PASSWORD,
    })
    initialized = true

    await api.downloadBudget(process.env.ACTUAL_SYNC_ID, {
      password: process.env.ACTUAL_ENCRYPTION_PASSWORD,
    })

    let result = { added: [], updated: [], errors: [] }
    if (toImport.length) {
      result = await api.importTransactions(ACTUAL_ACCOUNT_ID, toImport)
    }

    // Plaid says these were removed (e.g. a posted transaction that got reversed)
    let deleted = 0
    for (const r of toRemove) {
      const { data } = await api.runQuery(
        api
          .q('transactions')
          .filter({ account: ACTUAL_ACCOUNT_ID, imported_id: r.transaction_id })
          .select(['id'])
      )
      for (const row of data) {
        await api.deleteTransaction(row.id)
        deleted++
      }
    }

    // Push changes to the server
    await api.sync()

    // Only advance the cursor after Actual has the data, so a failed run just retries
    await saveCursor(nextCursor)

    return Response.json({
      ok: true,
      imported: result.added?.length ?? 0,
      updated: result.updated?.length ?? 0,
      deleted,
      errors: result.errors ?? [],
    })
  } catch (err) {
    console.error(err?.response?.data || err)
    return Response.json(
      { error: err?.response?.data?.error_message || err.message },
      { status: 500 }
    )
  } finally {
    if (initialized) {
      try {
        await api.shutdown()
      } catch {}
    }
  }
}

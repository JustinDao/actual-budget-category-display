import * as api from '@actual-app/api'
import { mkdirSync } from 'fs'
import { Configuration, PlaidApi, PlaidEnvironments, type Transaction, type RemovedTransaction } from 'plaid'
import { pingHealthcheck } from './healthchecks.js'
import { errorMessage } from '../lib/errors.js'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Each budget file on the Pikapod that should receive the Bilt Palladium transactions.
// Account IDs are per budget file, so each target has its own.
const TARGETS = [
  {
    name: 'main',
    syncId: process.env.ACTUAL_SYNC_ID,
    accountId: process.env.BILT_ACTUAL_ACCOUNT_ID || 'fb530a42-7007-4168-a9ca-184a647cf356',
    encryptionPassword: process.env.ACTUAL_ENCRYPTION_PASSWORD, // undefined if not encrypted
  },
  {
    name: 'joint',
    syncId: process.env.ACTUAL_SYNC_ID_2,
    accountId: process.env.BILT_ACTUAL_ACCOUNT_ID_2 || '4cc17816-a2e1-41af-9d3b-bab011eed122',
    encryptionPassword: undefined, // this file has no end-to-end encryption
  },
]

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

async function getCursor(): Promise<string | null> {
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(CURSOR_KEY)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  })
  if (!res.ok) throw new Error(`Upstash read failed: ${res.status}`)
  const body: { result?: unknown } = await res.json()
  if (typeof body.result !== 'string' || !body.result) return null
  try {
    const value: unknown = JSON.parse(body.result)
    if (
      typeof value === 'object' &&
      value !== null &&
      'cursor' in value &&
      typeof value.cursor === 'string'
    ) {
      return value.cursor
    }
    return null
  } catch {
    return null
  }
}

async function saveCursor(cursor: string): Promise<void> {
  const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(CURSOR_KEY)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify({ cursor, updatedAt: new Date().toISOString() }),
  })
  if (!res.ok) throw new Error(`Upstash write failed: ${res.status}`)
}

// Pull everything since `startCursor`. If Plaid reports the data changed mid-pagination,
// restart from the original cursor, as their docs instruct.
async function pullFromPlaid(startCursor: string | null): Promise<{
  added: Transaction[]
  modified: Transaction[]
  removed: RemovedTransaction[]
  nextCursor: string | undefined
}> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let cursor = startCursor ?? undefined
      const added: Transaction[] = []
      const modified: Transaction[] = []
      const removed: RemovedTransaction[] = []
      let hasMore = true

      while (hasMore) {
        const { data } = await plaid.transactionsSync({
          access_token: process.env.PLAID_ACCESS_TOKEN!,
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
      const code = plaidErrorCode(err)
      if (code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < 3) continue
      throw err
    }
  }
  throw new Error('Plaid sync exhausted its retry attempts')
}

function plaidErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined
  const response = error.response
  if (typeof response !== 'object' || response === null || !('data' in response)) return undefined
  const data = response.data
  return typeof data === 'object' &&
    data !== null &&
    'error_code' in data &&
    typeof data.error_code === 'string'
    ? data.error_code
    : undefined
}

// Plaid: positive = money out of the account (a card purchase), negative = money in
// (payment/refund). Actual: negative = spending. So flip the sign. Actual wants integer cents.
function toActual(t: Transaction, accountId: string) {
  return {
    account: accountId,
    date: t.date, // 'YYYY-MM-DD'
    amount: -Math.round(t.amount * 100),
    payee_name: t.merchant_name || t.name,
    imported_payee: t.name,
    imported_id: t.transaction_id, // stable ID -> Actual dedupes on re-import
    cleared: true,
  }
}

export async function GET(request: Request): Promise<Response> {
  // Fail closed if CRON_SECRET is missing. Vercel Cron sends this header automatically.
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const required = [
    'ACTUAL_SERVER_URL',
    'ACTUAL_PASSWORD',
    'ACTUAL_SYNC_ID',
    'ACTUAL_SYNC_ID_2',
    'BILT_ACTUAL_ACCOUNT_ID_2',
    'PLAID_CLIENT_ID',
    'PLAID_SECRET',
    'PLAID_ACCESS_TOKEN',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
  ]
  const missing = required.filter((k) => !process.env[k])
  if (missing.length) {
    await pingHealthcheck(process.env.HEALTHCHECKS_BILT_URL, 'failure', 'Bilt sync')
    return Response.json({ error: `Missing env vars: ${missing.join(', ')}` }, { status: 500 })
  }

  // ?dry=1 -> show what would be imported, touch nothing, don't advance the cursor
  const dry = new URL(request.url).searchParams.get('dry') === '1'

  let initialized = false
  try {
    const startCursor = await getCursor()
    const { added, modified, removed, nextCursor } = await pullFromPlaid(startCursor)

    const inScope = (transaction: Transaction | RemovedTransaction) =>
      !PLAID_ACCOUNT_FILTER || transaction.account_id === PLAID_ACCOUNT_FILTER

    // Skip pending: they get a different transaction_id once posted, which would duplicate.
    const posted = [...added, ...modified].filter((transaction) => inScope(transaction) && !transaction.pending)
    const toRemove = removed.filter(inScope)

    if (dry) {
      return Response.json({
        ok: true,
        dry: true,
        startedFromCursor: Boolean(startCursor),
        targets: TARGETS.map((t) => t.name),
        wouldImport: posted.length,
        wouldRemove: toRemove.length,
        sample: posted.slice(0, 10).map((t) => toActual(t, TARGETS[0].accountId)),
      })
    }

    mkdirSync('/tmp/actual-cache', { recursive: true })
    await api.init({
      dataDir: '/tmp/actual-cache',
      serverURL: process.env.ACTUAL_SERVER_URL!,
      password: process.env.ACTUAL_PASSWORD!,
    })
    initialized = true

    const results: Array<{
      target: string
      imported: number
      updated: number
      deleted: number
      errors: Array<{ message: string }>
    }> = []
    for (const target of TARGETS) {
      await api.downloadBudget(target.syncId!, { password: target.encryptionPassword })

      const result = posted.length
        ? await api.importTransactions(
          target.accountId,
          posted.map((t) => toActual(t, target.accountId))
        )
        : undefined

      // Plaid says these were removed (e.g. a posted transaction that got reversed)
      let deleted = 0
      for (const r of toRemove) {
        const queryResult = await api.runQuery(
          api
            .q('transactions')
            .filter({ account: target.accountId, imported_id: r.transaction_id })
            .select(['id'])
        )
        const data = getIdRows(queryResult)
        for (const row of data) {
          await api.deleteTransaction(row.id)
          deleted++
        }
      }

      // Push this budget's changes to the server before loading the next one
      await api.sync()

      results.push({
        target: target.name,
        imported: result?.added.length ?? 0,
        updated: result?.updated.length ?? 0,
        deleted,
        errors: result?.errors ?? [],
      })
    }

    function getIdRows(result: unknown): Array<{ id: string }> {
      if (typeof result !== 'object' || result === null || !('data' in result) || !Array.isArray(result.data)) {
        throw new Error('Unexpected Actual query result')
      }
      return result.data.map((row: unknown) => {
        if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string') {
          throw new Error('Unexpected Actual transaction query row')
        }
        return { id: row.id }
      })
    }

    const hasErrors = results.some((result) => result.errors.length > 0)
    if (hasErrors) {
      await pingHealthcheck(process.env.HEALTHCHECKS_BILT_URL, 'failure', 'Bilt sync')
      return Response.json({ ok: false, results }, { status: 500 })
    }

    // Only advance the cursor after EVERY budget has the data. If one target fails we throw
    // before this line, the next run retries both, and already-imported rows dedupe.
    if (nextCursor) await saveCursor(nextCursor)

    await pingHealthcheck(process.env.HEALTHCHECKS_BILT_URL, 'success', 'Bilt sync')
    return Response.json({ ok: true, results })
  } catch (error) {
    console.error(error)
    await pingHealthcheck(process.env.HEALTHCHECKS_BILT_URL, 'failure', 'Bilt sync')
    return Response.json(
      { error: errorMessage(error) },
      { status: 500 }
    )
  } finally {
    if (initialized) {
      try {
        await api.shutdown()
      } catch { }
    }
  }
}
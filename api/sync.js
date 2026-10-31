import * as api from '@actual-app/api'
import { mkdirSync } from 'fs'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN

// Safety cap on how many transactions get stored. The true count is stored too.
const MAX_STORED = 200

async function upstashSet(key, value) {
  const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify(value),
  })
  if (!res.ok) throw new Error(`Upstash write failed: ${res.status}`)
  return res.json()
}

// Current month as YYYY-MM in Seattle time (Vercel runs in UTC)
function currentMonthPT() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date())
  const y = parts.find((p) => p.type === 'year').value
  const m = parts.find((p) => p.type === 'month').value
  return `${y}-${m}`
}

export async function GET(request) {
  // Fail closed if CRON_SECRET is missing. Vercel Cron sends this header automatically.
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    mkdirSync('/tmp/actual-cache', { recursive: true })

    await api.init({
      dataDir: '/tmp/actual-cache',
      serverURL: process.env.ACTUAL_SERVER_URL,
      password: process.env.ACTUAL_PASSWORD,
    })

    await api.downloadBudget(process.env.ACTUAL_SYNC_ID, {
      password: process.env.ACTUAL_ENCRYPTION_PASSWORD,
    })

    const month = currentMonthPT()
    const budgetMonth = await api.getBudgetMonth(month)

    // Prefer matching by ID (stable); fall back to name
    const targetId = process.env.BUDGET_CATEGORY_ID
    const targetName = process.env.BUDGET_CATEGORY_NAME

    const category = budgetMonth.categoryGroups
      .flatMap((g) => g.categories)
      .find((c) => (targetId ? c.id === targetId : c.name === targetName))

    if (!category) {
      return Response.json({ error: 'Category not found' }, { status: 404 })
    }

    // Transactions in this category for the current month, newest first
    const { data: rows } = await api.runQuery(
      api
        .q('transactions')
        .filter({
          category: category.id,
          date: { $transform: '$month', $eq: month },
        })
        .select(['id', 'date', 'amount', 'payee.name', 'notes'])
        .orderBy({ date: 'desc' }),
    )

    const transactions = rows.slice(0, MAX_STORED).map((t) => ({
      id: t.id,
      date: t.date, // 'YYYY-MM-DD'
      amount: api.utils.integerToAmount(t.amount), // negative = spending, positive = refund
      payee: t['payee.name'] ?? null,
      notes: t.notes ?? null,
    }))

    const payload = {
      category: category.name,
      balance: api.utils.integerToAmount(category.balance),
      month,
      transactions,
      transactionCount: rows.length, // true total, even if the stored list was capped
      updatedAt: new Date().toISOString(),
    }

    await upstashSet('budget:amount', payload)

    return Response.json({
      ok: true,
      category: payload.category,
      balance: payload.balance,
      month: payload.month,
      transactionCount: payload.transactionCount,
      updatedAt: payload.updatedAt,
    })
  } catch (err) {
    console.error(err)
    return Response.json({ error: err.message }, { status: 500 })
  } finally {
    // Always shut down the API, success or failure
    try {
      await api.shutdown()
    } catch {}
  }
}

import * as api from '@actual-app/api'
import { mkdirSync } from 'fs'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN

// Rolling window: the most recent N transactions in the category, regardless of month
const TRANSACTION_LIMIT = 50

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
  const y = parts.find(p => p.type === 'year').value
  const m = parts.find(p => p.type === 'month').value
  return `${y}-${m}`
}

// How many months back to look for assigned (budgeted) amounts
const MAX_ASSIGNMENT_MONTHS = 12

// 'YYYY-MM' plus/minus N months
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
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
      .flatMap(g => g.categories)
      .find(c => (targetId ? c.id === targetId : c.name === targetName))

    if (!category) {
      return Response.json({ error: 'Category not found' }, { status: 404 })
    }

    // The most recent transactions in this category, newest first
    const { data: rows } = await api.runQuery(
      api
        .q('transactions')
        .filter({ category: category.id })
        .select(['id', 'date', 'amount', 'payee.name', 'notes'])
        .orderBy({ date: 'desc' })
        .limit(TRANSACTION_LIMIT)
    )

    const transactions = rows.map(t => ({
      id: t.id,
      date: t.date, // 'YYYY-MM-DD'
      amount: api.utils.integerToAmount(t.amount), // negative = spending, positive = refund
      payee: t['payee.name'] ?? null,
      notes: t.notes ?? null,
    }))

    // Assigned (budgeted) amount per month, from the oldest listed transaction's month to now
    const oldestMonth = transactions.length
      ? transactions[transactions.length - 1].date.slice(0, 7)
      : month
    const earliestAllowed = shiftMonth(month, -(MAX_ASSIGNMENT_MONTHS - 1))
    const startMonth = oldestMonth > earliestAllowed ? oldestMonth : earliestAllowed

    const assignments = []
    for (let m = startMonth; m <= month; m = shiftMonth(m, 1)) {
      try {
        const bm = m === month ? budgetMonth : await api.getBudgetMonth(m)
        const cat = bm.categoryGroups
          .flatMap(g => g.categories)
          .find(c => c.id === category.id)
        const amount = cat ? api.utils.integerToAmount(cat.budgeted) : 0
        if (amount !== 0) assignments.push({ month: m, amount })
      } catch (err) {
        console.error(`getBudgetMonth(${m}) failed:`, err.message)
      }
    }

    const payload = {
      category: category.name,
      balance: api.utils.integerToAmount(category.balance),
      month,
      transactions,
      assignments,
      updatedAt: new Date().toISOString(),
    }

    await upstashSet('budget:amount', payload)

    return Response.json({
      ok: true,
      category: payload.category,
      balance: payload.balance,
      month: payload.month,
      transactionCount: transactions.length,
      updatedAt: payload.updatedAt,
    })
  } catch (err) {
    console.error(err)
    return Response.json({ error: err.message }, { status: 500 })
  } finally {
    // Always shut down the API, success or failure
    try {
      await api.shutdown()
    } catch { }
  }
}

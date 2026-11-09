import * as api from '@actual-app/api'
import { mkdirSync } from 'fs'
import { errorMessage } from '../lib/errors.js'
import { pingHealthcheck } from './healthchecks.js'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN

// Rolling window: the most recent N transactions in the category, regardless of month
const TRANSACTION_LIMIT = 50

async function upstashSet(key: string, value: unknown): Promise<unknown> {
  const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify(value),
  })
  if (!res.ok) throw new Error(`Upstash write failed: ${res.status}`)
  return res.json()
}

// Current month as YYYY-MM in Seattle time (Vercel runs in UTC)
function currentMonthPT(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date())
  const y = parts.find((part) => part.type === 'year')?.value
  const m = parts.find((part) => part.type === 'month')?.value
  if (!y || !m) throw new Error('Could not determine the current month in Pacific time')
  return `${y}-${m}`
}

// How many months back to look for assigned (budgeted) amounts
const MAX_ASSIGNMENT_MONTHS = 12

interface BudgetCategory {
  id: string
  name: string
  budgeted: number
  balance: number
}

// Categories we've already warned about, so the 12-month assignment loop doesn't repeat itself
const warnedCategories = new Set<string>()

function toBudgetCategory(category: Record<string, unknown>): BudgetCategory | null {
  if (
    typeof category.id !== 'string' ||
    typeof category.name !== 'string' ||
    typeof category.budgeted !== 'number' ||
    typeof category.balance !== 'number'
  ) {
    return null
  }
  return {
    id: category.id,
    name: category.name,
    budgeted: category.budgeted,
    balance: category.balance,
  }
}

// getBudgetMonth can return categories that have no numeric budgeted/balance (e.g. income
// categories). Skip those instead of failing the whole sync, and log their shape once so a
// genuinely unexpected category is visible. Only field TYPES are logged, never amounts.
function getBudgetCategories(
  groups: Array<Record<string, unknown> & { categories?: Record<string, unknown>[] }>,
): BudgetCategory[] {
  return groups.flatMap((group) =>
    (group.categories ?? []).flatMap((category) => {
      const parsed = toBudgetCategory(category)
      if (parsed) return [parsed]

      const key = String(category.id)
      if (!warnedCategories.has(key)) {
        warnedCategories.add(key)
        console.warn(
          'Skipping category without numeric budgeted/balance:',
          JSON.stringify({
            group: group.name,
            groupIsIncome: group.is_income,
            category: category.name,
            fieldTypes: Object.fromEntries(Object.entries(category).map(([field, value]) => [field, typeof value])),
          }),
        )
      }
      return []
    }),
  )
}

interface TransactionQueryRow {
  id: string
  date: string
  amount: number
  'payee.name'?: unknown
  notes?: unknown
}

function getTransactionRows(result: unknown): TransactionQueryRow[] {
  if (typeof result !== 'object' || result === null || !('data' in result) || !Array.isArray(result.data)) {
    throw new Error('Unexpected Actual query result')
  }
  return result.data.map((row: unknown) => {
    if (
      typeof row !== 'object' ||
      row === null ||
      !('id' in row) ||
      typeof row.id !== 'string' ||
      !('date' in row) ||
      typeof row.date !== 'string' ||
      !('amount' in row) ||
      typeof row.amount !== 'number'
    ) {
      throw new Error('Unexpected Actual transaction query row')
    }
    const payeeName = 'payee.name' in row ? row['payee.name'] : null
    const notes = 'notes' in row ? row.notes : null
    return {
      id: row.id,
      date: row.date,
      amount: row.amount,
      'payee.name': payeeName,
      notes,
    }
  })
}

// 'YYYY-MM' plus/minus N months
function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export async function GET(request: Request): Promise<Response> {
  // Fail closed if CRON_SECRET is missing. Vercel Cron sends this header automatically.
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    mkdirSync('/tmp/actual-cache', { recursive: true })

    await api.init({
      dataDir: '/tmp/actual-cache',
      serverURL: process.env.ACTUAL_SERVER_URL!,
      password: process.env.ACTUAL_PASSWORD!,
    })

    await api.downloadBudget(process.env.ACTUAL_SYNC_ID!, {
      password: process.env.ACTUAL_ENCRYPTION_PASSWORD,
    })

    const month = currentMonthPT()
    const budgetMonth = await api.getBudgetMonth(month)

    // Prefer matching by ID (stable); fall back to name
    const targetId = process.env.BUDGET_CATEGORY_ID
    const targetName = process.env.BUDGET_CATEGORY_NAME

    const category = getBudgetCategories(budgetMonth.categoryGroups).find((candidate) =>
      targetId ? candidate.id === targetId : candidate.name === targetName,
    )

    if (!category) {
      await pingHealthcheck(process.env.HEALTHCHECKS_ACTUAL_URL, 'failure', 'Actual sync')
      return Response.json({ error: 'Category not found' }, { status: 404 })
    }

    // The most recent transactions in this category, newest first
    const queryResult = await api.runQuery(
      api
        .q('transactions')
        .filter({ category: category.id })
        .select(['id', 'date', 'amount', 'payee.name', 'notes'])
        .orderBy({ date: 'desc' })
        .limit(TRANSACTION_LIMIT),
    )
    const rows = getTransactionRows(queryResult)

    const transactions = rows.map((t) => ({
      id: t.id,
      date: t.date, // 'YYYY-MM-DD'
      amount: api.utils.integerToAmount(t.amount), // negative = spending, positive = refund
      payee: typeof t['payee.name'] === 'string' ? t['payee.name'] : null,
      notes: typeof t.notes === 'string' ? t.notes : null,
    }))

    // Assigned (budgeted) amount per month, from the oldest listed transaction's month to now
    const oldestMonth = transactions.length ? transactions[transactions.length - 1].date.slice(0, 7) : month
    const earliestAllowed = shiftMonth(month, -(MAX_ASSIGNMENT_MONTHS - 1))
    const startMonth = oldestMonth > earliestAllowed ? oldestMonth : earliestAllowed

    const assignments: Array<{ month: string; amount: number }> = []
    const assignmentErrors: string[] = []
    for (let m = startMonth; m <= month; m = shiftMonth(m, 1)) {
      try {
        const bm = m === month ? budgetMonth : await api.getBudgetMonth(m)
        const cat = getBudgetCategories(bm.categoryGroups).find((candidate) => candidate.id === category.id)
        const amount = cat ? api.utils.integerToAmount(cat.budgeted) : 0
        if (amount !== 0) assignments.push({ month: m, amount })
      } catch (err) {
        console.error(`getBudgetMonth(${m}) failed:`, errorMessage(err))
        assignmentErrors.push(m)
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

    const hasErrors = assignmentErrors.length > 0
    await pingHealthcheck(process.env.HEALTHCHECKS_ACTUAL_URL, hasErrors ? 'failure' : 'success', 'Actual sync')

    return Response.json(
      {
        ok: !hasErrors,
        category: payload.category,
        balance: payload.balance,
        month: payload.month,
        transactionCount: transactions.length,
        assignmentErrors,
        updatedAt: payload.updatedAt,
      },
      { status: hasErrors ? 500 : 200 },
    )
  } catch (error) {
    console.error(error)
    await pingHealthcheck(process.env.HEALTHCHECKS_ACTUAL_URL, 'failure', 'Actual sync')
    return Response.json({ error: errorMessage(error) }, { status: 500 })
  } finally {
    // Always shut down the API, success or failure
    try {
      await api.shutdown()
    } catch {}
  }
}

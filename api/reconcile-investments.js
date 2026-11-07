import * as api from '@actual-app/api'
import { mkdirSync } from 'fs'
import { pingHealthcheck } from './healthchecks.js'

const RECONCILIATION_PAYEE = 'Automatic Investment Reconciliation'
const RECONCILIATION_NOTE = 'Automatically generated after bank sync'

function today() {
  const now = new Date()
  return now.toISOString().slice(0, 10)
}

export async function GET(request) {
  // Protect this endpoint with a secret so randos can't trigger it
  const authHeader = request.headers.get('authorization')
  const hasSecret = new URL(request.url).searchParams.get('secret') === process.env.CRON_SECRET

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && !hasSecret) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Env validation up front
  const required = ['ACTUAL_SERVER_URL', 'ACTUAL_PASSWORD', 'ACTUAL_SYNC_ID']
  const missing = required.filter((key) => !process.env[key])
  if (missing.length) {
    await pingHealthcheck(process.env.HEALTHCHECKS_ACTUAL_URL, 'failure', 'Actual sync')
    return Response.json({ error: `Missing required env vars: ${missing.join(', ')}` }, { status: 500 })
  }

  let initialized = false

  try {
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

    const accounts = await api.getAccounts()
    const openAccounts = accounts.filter((a) => !a.closed)

    // Step 1: bank sync every open account, one at a time — don't let one failure kill the rest
    const syncErrors = []
    for (const account of openAccounts) {
      try {
        await api.runBankSync({ accountId: account.id })
      } catch (err) {
        console.error(`Bank sync failed for ${account.name}:`, err.message)
        syncErrors.push({ account: account.name, error: err.message })
      }
    }

    // Refresh local cache with whatever bank sync just pulled in
    await api.sync()

    // Step 2: find investment accounts (re-fetch, since balance_current may have updated)
    const refreshedAccounts = await api.getAccounts()

    // Step 2: find investment accounts — `type` isn't reliably present via the API,
    // so we match against an explicit allowlist of account IDs instead.
    const investmentAccountIds = (process.env.INVESTMENT_ACCOUNT_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)

    const investmentAccounts = refreshedAccounts.filter(
      (a) => investmentAccountIds.includes(a.id) && a.balance_current != null && !a.closed,
    )

    const results = []

    for (const account of investmentAccounts) {
      try {
        const bankBalance = account.balance_current
        const ledgerBalance = await api.getAccountBalance(account.id)
        const diff = bankBalance - ledgerBalance

        if (diff === 0) {
          results.push({ account: account.name, status: 'already balanced' })
          continue
        }

        // Avoid duplicate reconciliation if this runs more than once today
        const todaysTransactions = await api.getTransactions(account.id, today(), today())
        const alreadyCreated = todaysTransactions.some(
          (tx) => tx.payee_name === RECONCILIATION_PAYEE && tx.notes === RECONCILIATION_NOTE,
        )

        if (alreadyCreated) {
          results.push({ account: account.name, status: 'already reconciled today' })
          continue
        }

        await api.addTransactions(account.id, [
          {
            account: account.id,
            date: today(),
            amount: diff,
            payee_name: RECONCILIATION_PAYEE,
            notes: RECONCILIATION_NOTE,
            cleared: true,
          },
        ])

        results.push({
          account: account.name,
          adjustment: diff / 100,
          status: 'reconciled',
        })

        console.log(`${account.name}: ${(diff / 100).toFixed(2)} adjustment created`)
      } catch (err) {
        console.error(`Reconciliation failed for ${account.name}:`, err.message)
        results.push({ account: account.name, status: 'error', error: err.message })
      }
    }

    // Push the new adjustment transactions back to the server
    await api.sync()

    await api.shutdown()

    const hasErrors = syncErrors.length > 0 || results.some((result) => result.status === 'error')
    await pingHealthcheck(
      process.env.HEALTHCHECKS_ACTUAL_URL,
      hasErrors ? 'failure' : 'success',
      'Actual sync',
    )

    return Response.json(
      { ok: !hasErrors, syncErrors, results },
      { status: hasErrors ? 500 : 200 },
    )
  } catch (err) {
    console.error(err)
    // Make sure we always shut down the api even on error
    if (initialized) {
      try {
        await api.shutdown()
      } catch {}
    }
    await pingHealthcheck(process.env.HEALTHCHECKS_ACTUAL_URL, 'failure', 'Actual sync')
    return Response.json({ error: err.message }, { status: 500 })
  }
}

// Shows what Plaid has for your Bilt Item, ignoring the stored cursor.
//   node --env-file=.env.local scripts/plaid-debug.mjs
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'

const access_token = process.env.PLAID_ACCESS_TOKEN
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

// Item health: when did Plaid last successfully / unsuccessfully pull transactions?
const { data: item } = await plaid.itemGet({ access_token })
console.log('Item status.transactions:', JSON.stringify(item.item.status?.transactions, null, 2))
console.log('Item error:', item.item.error ?? 'none')

// Full sync from scratch (no cursor); read-only, nothing is saved
let cursor
let all = []
let status
let hasMore = true
while (hasMore) {
  const { data } = await plaid.transactionsSync({ access_token, cursor, count: 500 })
  all.push(...data.added, ...data.modified)
  status = data.transactions_update_status
  cursor = data.next_cursor
  hasMore = data.has_more
}
console.log('transactions_update_status:', status)
console.log('total returned:', all.length)
console.log('pending:', all.filter((t) => t.pending).length)
for (const t of all.slice(-10)) {
  console.log(t.date, t.pending ? 'PENDING' : 'posted ', t.amount, t.merchant_name || t.name, t.account_id)
}

const { data: accts } = await plaid.accountsGet({ access_token })
for (const a of accts.accounts) {
  console.log(a.account_id, a.name, a.subtype, 'current:', a.balances.current, 'limit:', a.balances.limit)
}
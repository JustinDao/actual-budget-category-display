// One-time helper: connect your Bilt card via Plaid Link and print the access token.
//
//   PLAID_CLIENT_ID=... PLAID_SECRET=... node scripts/plaid-link.mjs
//
// Then open http://localhost:3000, pick "Bilt Rewards", log in. The access token and
// account IDs are printed in this terminal. Put the token in Vercel as PLAID_ACCESS_TOKEN.
// Keep it safe: on a Trial plan every Item you create counts against your 10-Item cap.

import http from 'node:http'
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'

const { PLAID_CLIENT_ID, PLAID_SECRET } = process.env
if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.error('Set PLAID_CLIENT_ID and PLAID_SECRET (production secret).')
  process.exit(1)
}

const plaid = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments.production,
    baseOptions: {
      headers: { 'PLAID-CLIENT-ID': PLAID_CLIENT_ID, 'PLAID-SECRET': PLAID_SECRET },
    },
  })
)

const page = (linkToken) => `<!doctype html>
<meta charset="utf-8"><title>Connect Bilt</title>
<body style="font-family:system-ui;padding:2rem">
<p id="msg">Opening Plaid Link…</p>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
  const msg = document.getElementById('msg')
  const handler = Plaid.create({
    token: ${JSON.stringify(linkToken)},
    onSuccess: async (public_token) => {
      const r = await fetch('/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ public_token }),
      })
      msg.textContent = r.ok ? 'Connected. Check your terminal for the access token.' : 'Exchange failed. Check your terminal.'
    },
    onExit: (err) => { msg.textContent = err ? 'Link exited: ' + (err.error_message || err.error_code) : 'Closed.' },
  })
  handler.open()
</script>`

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      const { data } = await plaid.linkTokenCreate({
        user: { client_user_id: 'justin-actual-budget' },
        client_name: 'Actual Budget Bilt Import',
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
        transactions: { days_requested: 730 }, // history available on first sync
      })
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(page(data.link_token))
      return
    }

    if (req.method === 'POST' && req.url === '/exchange') {
      let body = ''
      for await (const chunk of req) body += chunk
      const { public_token } = JSON.parse(body)

      const { data } = await plaid.itemPublicTokenExchange({ public_token })
      const { data: accts } = await plaid.accountsGet({ access_token: data.access_token })

      console.log('\n=== SAVE THESE ===')
      console.log('PLAID_ACCESS_TOKEN =', data.access_token)
      console.log('Item ID            =', data.item_id)
      console.log('Accounts:')
      for (const a of accts.accounts) {
        console.log(`  ${a.account_id}  ${a.name} (${a.subtype}) ••${a.mask}`)
      }
      console.log('Optional: set PLAID_ACCOUNT_ID to the card account_id above.\n')

      res.writeHead(200).end('ok')
      return
    }

    res.writeHead(404).end()
  } catch (err) {
    console.error(err?.response?.data || err)
    res.writeHead(500).end('error')
  }
})

server.listen(3000, () => console.log('Open http://localhost:3000'))

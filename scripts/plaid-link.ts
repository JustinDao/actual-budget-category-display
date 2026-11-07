// One-time helper: connect your Bilt card via Plaid Link and print the access token.
//
//   PLAID_CLIENT_ID=... PLAID_SECRET=... npm run plaid-link
//
// Then open http://localhost:3000, pick "Bilt Rewards", log in. The access token and
// account IDs are printed in this terminal. Put the token in Vercel as PLAID_ACCESS_TOKEN.
// Keep it safe: on a Trial plan every Item you create counts against your 10-Item cap.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Configuration, PlaidApi, PlaidEnvironments, CountryCode, Products } from 'plaid'

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

const clientScriptPath = resolve(dirname(fileURLToPath(import.meta.url)), '../.build/plaid-link-client.js')
const clientScript = await readFile(clientScriptPath, 'utf8')

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

const page = (linkToken: string) => `<!doctype html>
<meta charset="utf-8"><title>Connect Bilt</title>
<body data-link-token="${escapeHtml(linkToken)}" style="font-family:system-ui;padding:2rem">
<p id="msg">Opening Plaid Link…</p>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script src="/client.js" defer></script>`

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'GET' && url.pathname === '/client.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(clientScript)
      return
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const { data } = await plaid.linkTokenCreate({
        user: { client_user_id: 'justin-actual-budget' },
        client_name: 'Actual Budget Bilt Import',
        products: [Products.Transactions],
        country_codes: [CountryCode.Us],
        language: 'en',
        transactions: { days_requested: 730 }, // history available on first sync
      })
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(page(data.link_token))
      return
    }

    if (req.method === 'POST' && url.pathname === '/exchange') {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (
        typeof body !== 'object' ||
        body === null ||
        !('public_token' in body) ||
        typeof body.public_token !== 'string'
      ) {
        throw new Error('Request body must include a public_token')
      }
      const publicToken = body.public_token

      const { data } = await plaid.itemPublicTokenExchange({ public_token: publicToken })
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
    console.error(err)
    res.writeHead(500).end('error')
  }
})

server.listen(3000, () => console.log('Open http://localhost:3000'))

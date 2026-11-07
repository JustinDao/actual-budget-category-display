import { GET } from '../api/import-bilt.js'

const live = process.env.LIVE === '1'
const url = `http://localhost/api/import-bilt${live ? '' : '?dry=1'}`
const response = await GET(new Request(url, {
  headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
}))
console.log(response.status, JSON.stringify(await response.json(), null, 2))
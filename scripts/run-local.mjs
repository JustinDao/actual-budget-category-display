import { GET } from '../api/import-bilt.js'

const live = process.env.LIVE === '1'
const url = `http://localhost/api/import-bilt${live ? '' : '?dry=1'}`
const res = await GET(new Request(url, {
  headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
}))
console.log(res.status, JSON.stringify(await res.json(), null, 2))
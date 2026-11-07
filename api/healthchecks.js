export async function pingHealthcheck(url, outcome, jobName) {
  if (!url) return

  const endpoint = `${url.replace(/\/+$/, '')}${outcome === 'failure' ? '/fail' : ''}`

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      console.error(`Healthchecks ${jobName} ping failed with status ${response.status}`)
    }
  } catch (err) {
    console.error(`Healthchecks ${jobName} ping failed:`, err)
  }
}

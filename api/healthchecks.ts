export async function pingHealthcheck(
  url: string | undefined,
  outcome: 'success' | 'failure',
  jobName: string,
): Promise<void> {
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
  } catch (error) {
    console.error(`Healthchecks ${jobName} ping failed:`, error)
  }
}

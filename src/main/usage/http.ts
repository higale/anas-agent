/** Bound every provider response, including error bodies; never expose raw response text. */
export async function requestJson(url: string, options: RequestInit): Promise<any> {
  const response = await fetch(url, { ...options, redirect: 'error' })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate' : 'network')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('response')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1024 * 1024) throw new Error('response')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('response') }
}

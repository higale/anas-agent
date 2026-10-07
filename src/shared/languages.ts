// Keep host preferences and plugin language selection consistent.
export function matchLanguageCode(code: string, available: string[]): string | undefined {
  const normalized = code.trim().toLowerCase()
  if (!normalized) return undefined
  return available.find(item => item.toLowerCase() === normalized)
    ?? available.find(item => item.split('-')[0].toLowerCase() === normalized.split('-')[0])
}

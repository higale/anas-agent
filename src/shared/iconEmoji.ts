import unicode from 'emojibase-data/meta/unicode.json'

const emojis = new Set<string>(unicode)

/** An omitted emoji keeps the project's existing image or built-in icon. */
export function normalizeIconEmoji(value: unknown): string {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || !emojis.has(value)) throw new Error('Project icon emoji is invalid.')
  return value
}

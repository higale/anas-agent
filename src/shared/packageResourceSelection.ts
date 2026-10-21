/** Package-local IDs keep capability choices portable when an Agent is copied. */
export type PackageResourceSelection = Record<string, boolean>

export function validatePackageResourceSelection(value: unknown): PackageResourceSelection {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid package resource selection.')
  const entries = Object.entries(value)
  if (entries.length > 4096 || entries.some(([id, enabled]) => !id.trim() || id.length > 512 || typeof enabled !== 'boolean')) {
    throw new Error('Package resource selections must map local IDs to booleans.')
  }
  return Object.fromEntries(entries)
}

export function packageResourceKey(resource: { id: string; rootId: string }): string {
  const prefix = `${resource.rootId}:`
  if (!resource.id.startsWith(prefix) || resource.id.length === prefix.length) throw new Error('Invalid package resource identity.')
  return resource.id.slice(prefix.length)
}

export function packageResourceEnabled(selection: PackageResourceSelection | undefined, resource: { id: string; rootId: string }): boolean {
  const key = packageResourceKey(resource)
  return !selection || !Object.hasOwn(selection, key) || selection[key] !== false
}

import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { ProjectOperationFailure } from '@shared/projectOperation'
import { samePath } from './pathContainment'

export function resourceDirectoryName(path: string, kind: 'skills' | 'tools'): string {
  const leaf = basename(path)
  if (leaf.toLowerCase() !== kind) return leaf || path
  const parent = dirname(path)
  const parentName = basename(parent)
  if (parentName === '.agents' || parentName === '.codex') return basename(dirname(parent)) || leaf
  return parentName || leaf
}

/** Validate references without requiring offline or removed directories to exist. */
export function parseResourceDirectories(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(path => typeof path !== 'string' || !isAbsolute(path) || !path.trim())) {
    throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Resource directories must be absolute directory paths.')
  }
  const paths: string[] = []
  for (const path of value as string[]) {
    const normalized = resolve(path)
    if (!paths.some(existing => samePath(existing, normalized))) paths.push(normalized)
  }
  return paths
}

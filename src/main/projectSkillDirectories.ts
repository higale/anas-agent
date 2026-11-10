import { isAbsolute, resolve } from 'node:path'
import { ProjectOperationFailure } from '@shared/projectOperation'
import { samePath } from './pathContainment'

/** Validate references without requiring offline or removed directories to exist. */
export function parseProjectSkillDirectories(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(path => typeof path !== 'string' || !isAbsolute(path) || !path.trim())) {
    throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Skill directories must be absolute directory paths.')
  }
  const paths: string[] = []
  for (const path of value as string[]) {
    const normalized = resolve(path)
    if (!paths.some(existing => samePath(existing, normalized))) paths.push(normalized)
  }
  return paths
}

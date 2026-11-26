import { lstat, realpath } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { samePath } from './pathContainment'

/** Bind a directory traversal to the original non-linked filesystem object. */
export async function guardCleanupDirectory(path: string, expected?: Stats): Promise<() => Promise<void>> {
  const identity = expected ?? await lstat(path)
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error(`Cleanup directory is not a regular directory: ${path}`)
  const canonical = await realpath(path)
  const verify = async () => {
    const current = await lstat(path)
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== identity.dev || current.ino !== identity.ino
      || !samePath(await realpath(path), canonical)) {
      throw new Error(`Cleanup directory changed: ${path}`)
    }
  }
  await verify()
  return verify
}

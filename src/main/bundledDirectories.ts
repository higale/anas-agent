import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Refresh app-owned examples/resources without changing imported user copies. */
export async function mirrorBundledDirectories(source: string, target: string, manifestName: string | undefined, validate: (path: string, name: string) => Promise<unknown>): Promise<void> {
  const stage = join(dirname(target), `.${basename(target)}.mirror.tmp`)
  const previous = join(dirname(target), `.${basename(target)}.mirror.previous`)
  await mkdir(dirname(target), { recursive: true })
  await rm(stage, { recursive: true, force: true })
  await rm(previous, { recursive: true, force: true })
  // Copy the entire tree, including root-level documentation. Validate the
  // staged snapshot so no category is published before the others are ready.
  await cp(source, stage, { recursive: true, errorOnExist: true, force: false })
  await validateBundledDirectories(stage, validate)
  const existing = await lstat(target).catch(reason => {
    if (reason.code === 'ENOENT') return undefined
    throw reason
  })
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Bundled resource destination must be a regular directory: ${target}`)
    const packageManifest = manifestName && await lstat(join(target, manifestName)).catch(reason => {
      if (reason.code === 'ENOENT') return undefined
      throw reason
    })
    if (packageManifest) throw new Error(`Bundled resource destination is occupied by a package: ${target}. Move that package elsewhere before starting Anas.`)
    await rename(target, previous)
  }
  try {
    await rename(stage, target)
  } catch (reason) {
    if (existing) {
      try { await rename(previous, target) } catch (rollback) {
        throw new AggregateError([reason, rollback], `Bundled resource replacement failed; previous files remain at ${previous}.`)
      }
    }
    throw reason
  }
  await rm(previous, { recursive: true, force: true })
}

export async function validateBundledDirectories(root: string, validate: (path: string, name: string) => Promise<unknown>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isFile()) continue
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Bundled resource must be a regular directory: ${join(root, entry.name)}`)
    await validate(join(root, entry.name), entry.name)
  }
}

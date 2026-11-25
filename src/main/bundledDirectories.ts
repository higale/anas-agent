import { readdir, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { getBundledDataDir, getBundledExamplesDir } from './config/dataDir'
import { isSameOrInsideDirectory } from './pathContainment'

// Resolve missing children through their existing parent before any creation.
async function resourcePath(path: string): Promise<string> {
  const target = resolve(path)
  let parent = target
  while (true) {
    try { return join(await realpath(parent), relative(parent, target)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error
      parent = dirname(parent)
    }
  }
}

export async function isBundledResourcePath(path: string, includeAncestors = false): Promise<boolean> {
  const roots = [getBundledDataDir(), getBundledExamplesDir()]
  const [target, ...canonicalRoots] = await Promise.all([resourcePath(path), ...roots.map(resourcePath)])
  return [...roots, ...canonicalRoots].some(root => [resolve(path), target].some(candidate =>
    isSameOrInsideDirectory(root, candidate) || includeAncestors && isSameOrInsideDirectory(candidate, root)))
}

/** Editable catalogs cannot own a bundled directory or any of its parents. */
export async function assertUserResourceDirectory(path: string): Promise<void> {
  if (await isBundledResourcePath(path, true)) {
    throw new Error('This directory overlaps bundled resources already managed by Anas. Import a copy before editing.')
  }
}

export async function assertWritablePackagePath(path: string): Promise<void> {
  if (await isBundledResourcePath(path)) throw new Error('Bundled resource files are read-only.')
}

export async function validateBundledDirectories(root: string, validate: (path: string, name: string) => Promise<unknown>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isFile()) continue
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Bundled resource must be a regular directory: ${join(root, entry.name)}`)
    await validate(join(root, entry.name), entry.name)
  }
}

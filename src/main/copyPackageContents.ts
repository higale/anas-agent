import { constants, type Stats } from 'node:fs'
import { chmod, copyFile, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isSameOrInsideDirectory } from './pathContainment'

interface PackageEntry {
  name: string
  actual: string
  info: Stats
  depth: number
}

/** Copy into a fresh staging directory. Each logical entry gets its own writable contents. */
export async function copyPackageContents(source: string, destination: string,
  checkEntry?: (entry: PackageEntry) => void | Promise<void>): Promise<void> {
  const stage = await realpath(destination)
  const ancestors = new Set<string>()
  async function copy(from: string, to: string, depth: number): Promise<void> {
    const actual = await realpath(from)
    const info = await stat(actual)
    await checkEntry?.({ name: basename(from), actual, info, depth })
    if (info.isFile()) {
      await copyFile(actual, to, constants.COPYFILE_EXCL)
      if ((await stat(to)).size !== info.size) throw new Error(`Package file changed during import: ${from}`)
      await chmod(to, (info.mode & 0o777) | 0o600)
      return
    }
    if (!info.isDirectory()) throw new Error(`Package entry must be a regular file or directory: ${from}`)
    if (ancestors.has(actual)) throw new Error(`Circular directory link in package: ${from}`)
    if (isSameOrInsideDirectory(actual, stage) || isSameOrInsideDirectory(stage, actual)) {
      throw new Error(`Package directory overlaps its import destination: ${from}`)
    }
    if (depth) await mkdir(to, { mode: 0o700 })
    ancestors.add(actual)
    for (const name of await readdir(actual)) await copy(join(actual, name), join(to, name), depth + 1)
    ancestors.delete(actual)
    await chmod(to, (info.mode & 0o777) | 0o700)
  }
  await copy(source, stage, 0)
}

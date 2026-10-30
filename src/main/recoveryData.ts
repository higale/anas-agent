import { constants } from 'node:fs'
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resettableConfigFiles, type ResettableConfigFile } from '@shared/recovery'
import { isSameOrInsideDirectory, samePath } from './pathContainment'

const excludedRoots = new Set(['electron', 'tmp', 'cache', 'dev'])
const maxEntries = 100_000
const maxBytes = 16 * 1024 ** 3

// Resolve missing destination components through their nearest existing ancestor
// before creating anything, so linked Documents folders cannot point into data.
export async function createPreservationDirectory(dataDir: string, destination: string): Promise<string> {
  const root = await realpath(dataDir)
  const target = resolve(destination)
  let ancestor = target
  let canonical: string
  while (true) {
    try {
      canonical = join(await realpath(ancestor), relative(ancestor, target))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error
      ancestor = dirname(ancestor)
    }
  }
  if (isSameOrInsideDirectory(root, canonical)) throw new Error('Recovery copies must be saved outside the application data directory.')
  await mkdir(target, { recursive: true, mode: 0o700 })
  const parent = await realpath(target)
  if (isSameOrInsideDirectory(root, parent)) throw new Error('Recovery copies must be saved outside the application data directory.')
  return mkdtemp(join(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-`))
}

// A forensic copy, not a logical SQLite backup. Call only after application
// writers have stopped. Preserve WAL/SHM and links without parsing damaged data.
export async function preserveRecoveryData(dataDir: string, destination: string): Promise<string> {
  const root = await realpath(dataDir)
  const output = await createPreservationDirectory(root, destination)
  const payload = join(output, 'data')
  let entries = 0
  let bytes = 0
  async function copy(source: string, target: string, depth: number): Promise<void> {
    if (++entries > maxEntries || depth > 64) throw new Error('Recovery copy exceeds the file count or directory depth limit.')
    const info = await lstat(source)
    if (info.isSymbolicLink()) {
      await cp(source, target, { dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false })
    } else if (info.isDirectory()) {
      await mkdir(target, { mode: 0o700 })
      for (const entry of await readdir(source)) await copy(join(source, entry), join(target, entry), depth + 1)
    } else if (info.isFile()) {
      bytes += info.size
      if (bytes > maxBytes) throw new Error('Recovery copy exceeds the 16 GiB limit.')
      await copyFile(source, target, constants.COPYFILE_EXCL)
    } else {
      throw new Error(`Cannot preserve special file: ${source}`)
    }
  }
  try {
    await mkdir(payload, { mode: 0o700 })
    for (const name of await readdir(root)) {
      if (!excludedRoots.has(name)) await copy(join(root, name), join(payload, name), 0)
    }
    await writeFile(join(output, 'recovery.json'), JSON.stringify({
      version: 0,
      source: root, createdAt: new Date().toISOString(), entries, bytes,
      excludedRoots: [...excludedRoots], symbolicLinks: 'Preserved without copying their targets',
      format: 'Raw data preservation; not a validated application backup'
    }, null, 2), { flag: 'wx', mode: 0o600 })
    return output
  } catch (error) {
    // Only our newly created, incomplete copy is removed. The source is untouched.
    await rm(output, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export function requireResettableConfigFile(file: unknown): ResettableConfigFile {
  if (typeof file !== 'string' || !resettableConfigFiles.includes(file as ResettableConfigFile)) {
    throw new Error('Select exactly one supported configuration file to reset.')
  }
  return file as ResettableConfigFile
}

export async function resetRecoveryConfig(dataDir: string, bundledDir: string, file: ResettableConfigFile): Promise<void> {
  requireResettableConfigFile(file)
  const root = await realpath(dataDir)
  const config = join(root, 'config')
  await mkdir(config, { recursive: true })
  if (!samePath(await realpath(config), config)) throw new Error('Cannot reset configuration through a linked directory.')
  const target = join(config, file)
  try {
    if (!(await lstat(target)).isFile()) throw new Error(`Cannot reset a non-regular configuration file: ${target}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const defaults = await readFile(join(bundledDir, file), 'utf8')
  JSON.parse(defaults)
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, defaults, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

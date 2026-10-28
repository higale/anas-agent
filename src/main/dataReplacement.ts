import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import fs from 'stubborn-fs'
import { shouldSkipBackupRelativePath } from './backupArchive'

export const executionResetEntries = [
  'db/catalog.sqlite', 'db/catalog.sqlite-wal', 'db/catalog.sqlite-shm', 'db/catalog.sqlite-journal',
  'db/conversations'
] as const
export const projectResetEntries = [
  'db/projects.json', 'db/project-deletion.json', 'db/project-deletion.stage.json', ...executionResetEntries
] as const
let restoreTail: Promise<void> = Promise.resolve()
// Windows can retain a directory handle briefly after plugin processes exit.
// Retry the same atomic move within a bound; permanent failures still roll back.
export const rename = fs.retry.rename({ timeout: 2_000, interval: 25 })

type RestorePhase = 'staged' | 'swapping' | 'activated' | 'committed' | 'restoring_previous' | 'rolled_back'

export interface RestoreJournal {
  version: 0
  dataDir: string
  phase: RestorePhase
  previousEntries: string[]
  installedEntries: string[]
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw reason
  }
}

export async function writeRestoreJournal(path: string, journal: RestoreJournal): Promise<void> {
  await validateRestoreJournal(journal, resolve(journal.dataDir), path)
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

async function validateRestoreJournal(value: unknown, dataDir: string, path: string): Promise<RestoreJournal> {
  const journal = value as Partial<RestoreJournal> | null
  const validEntries = (entries: unknown, allowDatabaseFiles: boolean): entries is string[] => {
    if (!Array.isArray(entries) || entries.length > 100_000) return false
    const roots = new Set<string>()
    for (const name of entries) {
      if (typeof name !== 'string' || !name || /[\\:]/.test(name) || name.includes('\0') || name === '.' || name === '..') return false
      if (name.includes('/')) {
        if (!allowDatabaseFiles || !projectResetEntries.some((target) => target === name)) return false
      } else if (shouldSkipBackupRelativePath(name)) return false
      else roots.add(name)
    }
    return new Set(entries).size === entries.length
      && !entries.some((name) => name.includes('/') && roots.has(name.split('/')[0]))
  }
  if (!journal || journal.version !== 0 || typeof journal.dataDir !== 'string'
    || !['staged', 'swapping', 'activated', 'committed', 'restoring_previous', 'rolled_back'].includes(journal.phase ?? '')
    || !validEntries(journal.previousEntries, true) || !validEntries(journal.installedEntries, false)) {
    throw new Error(`Invalid restore transaction journal: ${path}`)
  }
  if (resolve(journal.dataDir) !== dataDir) {
    // A restore can store the canonical root, while startup may receive an OS
    // alias such as /var instead of /private/var. Require the same real directory.
    let roots: string[]
    try { roots = await Promise.all([realpath(journal.dataDir), realpath(dataDir)]) }
    catch (cause) { throw new Error(`Invalid restore transaction journal: ${path}`, { cause }) }
    if (roots[0] !== roots[1]) throw new Error(`Invalid restore transaction journal: ${path}`)
  }
  return journal as RestoreJournal
}

export async function rollbackRestore(transactionRoot: string, journal: RestoreJournal): Promise<void> {
  const staged = join(transactionRoot, 'staged')
  const previous = join(transactionRoot, 'previous')
  if (journal.phase !== 'restoring_previous') {
    for (const name of [...journal.installedEntries].reverse()) {
      await rm(join(journal.dataDir, name), { recursive: true, force: true })
    }
    // Commit this boundary before moving any old entries back. Retrying cleanup
    // after a partial rollback would otherwise delete data already restored.
    journal.phase = 'restoring_previous'
    await writeRestoreJournal(join(transactionRoot, 'transaction.json'), journal)
  }
  for (const name of [...journal.previousEntries].reverse()) {
    const saved = join(previous, name)
    if (!(await pathExists(saved))) continue
    if (name.includes('/')) {
      const parent = dirname(join(journal.dataDir, name))
      await mkdir(parent, { recursive: true })
      if (!(await lstat(parent)).isDirectory()) throw new Error(`Cannot roll back through a linked directory: ${parent}`)
    }
    await rm(join(journal.dataDir, name), { recursive: true, force: true })
    await rename(saved, join(journal.dataDir, name))
  }
  journal.phase = 'rolled_back'
  await writeRestoreJournal(join(transactionRoot, 'transaction.json'), journal)
  await rm(staged, { recursive: true, force: true })
}

async function managedEntryNames(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return []
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => !shouldSkipBackupRelativePath(entry.name))
    .map((entry) => entry.name)
    .sort()
}

export async function swapRestoredData(transactionRoot: string, journal: RestoreJournal): Promise<void> {
  const staged = join(transactionRoot, 'staged')
  const previous = join(transactionRoot, 'previous')
  await mkdir(journal.dataDir, { recursive: true })
  await mkdir(previous)
  journal.phase = 'swapping'
  journal.previousEntries = await managedEntryNames(journal.dataDir)
  await writeRestoreJournal(join(transactionRoot, 'transaction.json'), journal)
  for (const name of journal.previousEntries) {
    await rename(join(journal.dataDir, name), join(previous, name))
  }
  for (const name of await managedEntryNames(staged)) {
    journal.installedEntries.push(name)
    await writeRestoreJournal(join(transactionRoot, 'transaction.json'), journal)
    await rename(join(staged, name), join(journal.dataDir, name))
  }
  journal.phase = 'activated'
  await writeRestoreJournal(join(transactionRoot, 'transaction.json'), journal)
}

export async function recoverInterruptedDataRestoreExcept(ignoredRoot: string | undefined, dataRoot: string): Promise<boolean> {
  const dataDir = resolve(dataRoot)
  const parent = dirname(dataDir)
  const prefix = `.anas-restore-v4-${basename(dataDir)}-`
  if (!(await pathExists(parent))) return false
  let recovered = false
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const root = join(parent, entry.name)
    if (ignoredRoot && resolve(root) === resolve(ignoredRoot)) continue
    const journalPath = join(root, 'transaction.json')
    try {
      const journal = await validateRestoreJournal(JSON.parse(await readFile(journalPath, 'utf8')), dataDir, journalPath)
      if (journal.phase !== 'committed' && journal.phase !== 'rolled_back') {
        await rollbackRestore(root, journal)
        recovered = true
      }
      await rm(root, { recursive: true, force: true })
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw reason
    }
  }
  return recovered
}

export function enqueueDataReplacement<T>(operation: () => Promise<T>): Promise<T> {
  const result = restoreTail.then(operation, operation)
  restoreTail = result.then(() => undefined, () => undefined)
  return result
}

// Recovery and execution conversion only, with writers stopped. Reuse the restore journal to
// commit metadata and all conversation databases together, including on crash.
export function replaceProjectData(
  root: string,
  prepare: (stagedRoot: string) => Promise<() => Promise<void>>,
  preserve: () => Promise<string>
): Promise<string> {
  return enqueueDataReplacement(async () => {
    const dataDir = resolve(root)
    await recoverInterruptedDataRestoreExcept(undefined, dataDir)
    const transactionRoot = await mkdtemp(join(dirname(dataDir), `.anas-restore-v4-${basename(dataDir)}-`))
    const staged = join(transactionRoot, 'staged'), previous = join(transactionRoot, 'previous')
    const journalPath = join(transactionRoot, 'transaction.json')
    const journal: RestoreJournal = { version: 0, dataDir, phase: 'staged', previousEntries: [], installedEntries: [] }
    let cleanup = true
    try {
      await mkdir(staged)
      await mkdir(previous)
      await writeRestoreJournal(journalPath, journal)
      const verifyUnchanged = await prepare(staged)
      const preservationPath = await preserve()
      await verifyUnchanged()
      const entries = ['db']
      for (const name of entries) if (await pathExists(join(dataDir, name))) journal.previousEntries.push(name)
      journal.phase = 'swapping'
      await writeRestoreJournal(journalPath, journal)
      cleanup = false
      for (const name of journal.previousEntries) await rename(join(dataDir, name), join(previous, name))
      for (const name of entries) {
        if (!(await pathExists(join(staged, name)))) continue
        journal.installedEntries.push(name)
        await writeRestoreJournal(journalPath, journal)
        await rename(join(staged, name), join(dataDir, name))
      }
      journal.phase = 'committed'
      await writeRestoreJournal(journalPath, journal)
      cleanup = true
      return preservationPath
    } catch (error) {
      if (!cleanup) {
        try { await rollbackRestore(transactionRoot, journal); cleanup = true }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Project data replacement failed and could not be rolled back safely.') }
      }
      throw error
    } finally {
      if (cleanup) await rm(transactionRoot, { recursive: true, force: true })
    }
  })
}

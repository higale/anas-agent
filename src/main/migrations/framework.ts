import { randomUUID } from 'node:crypto'
import { link, lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { writeJsonFileAtomic } from '../atomicJson'

type Document = Record<string, unknown>
export interface JsonMigrationStep {
  from: number
  to: number
  upgrade: (document: Document) => Document
}
export interface JsonMigration {
  path: string
  currentVersion: number
  steps: readonly JsonMigrationStep[]
  validateCurrent: (document: Document) => void
}

function documentVersion(document: unknown, migration: JsonMigration): number {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error(`Invalid migration document: ${migration.path}`)
  const version = (document as Document).version
  if ((document as Document).version === null || !Number.isInteger(version) || (version as number) < 0 || (version as number) > migration.currentVersion) {
    throw new Error(`Unsupported data version: ${migration.path}`)
  }
  return version as number
}

async function prepare(migration: JsonMigration) {
  if (!Number.isInteger(migration.currentVersion) || migration.currentVersion < 0) throw new Error(`Invalid migration version: ${migration.path}`)
  let source: string
  try { source = await readFile(migration.path, 'utf8') }
  catch (reason) {
    // Provisioning and required-file validation belong to startup/restore, not migration.
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return
    throw reason
  }
  let document = JSON.parse(source) as Document
  const originalVersion = documentVersion(document, migration)
  // Current data needs no upgrade work; its owner validates it on normal reads.
  if (originalVersion === migration.currentVersion) return
  const steps = new Map<number, JsonMigrationStep>()
  for (const step of migration.steps) {
    if (!Number.isInteger(step.from) || step.from < 0 || !Number.isInteger(step.to)
      || step.to <= step.from || step.to > migration.currentVersion || steps.has(step.from)) throw new Error(`Invalid migration steps: ${migration.path}`)
    steps.set(step.from, step)
  }
  let version = originalVersion
  while (version < migration.currentVersion) {
    const step = steps.get(version)
    if (!step) throw new Error(`Missing migration from version ${version}: ${migration.path}`)
    document = step.upgrade(document)
    if (document.version !== step.to) throw new Error(`Migration produced an incorrect version: ${migration.path}`)
    version = step.to
  }
  migration.validateCurrent(document)
  return { path: migration.path, source, document, originalVersion }
}

async function backupOriginal(path: string, source: string, version: number): Promise<void> {
  const backup = `${path}.v${version}.bak`
  const temporary = join(dirname(path), `.${basename(backup)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx' })
    try { await link(temporary, backup) }
    catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason
      if (!(await lstat(backup)).isFile() || await readFile(backup, 'utf8') !== source) {
        throw new Error(`Migration backup differs from the source: ${backup}`)
      }
    }
  } finally { await rm(temporary, { force: true }) }
}

/** Preflight the entire registry before writing; each file is independently atomic and retryable. */
export async function runJsonMigrations(migrations: readonly JsonMigration[]): Promise<void> {
  if (new Set(migrations.map(m => m.path)).size !== migrations.length) throw new Error('Duplicate migration path.')
  const prepared = []
  for (const migration of migrations) {
    const change = await prepare(migration)
    if (change) prepared.push(change)
  }
  for (const change of prepared) {
    // Catch edits after preflight rather than overwriting a newer user configuration.
    if (await readFile(change.path, 'utf8') !== change.source) throw new Error(`Data changed during migration: ${change.path}`)
    await backupOriginal(change.path, change.source, change.originalVersion)
    await writeJsonFileAtomic(change.path, change.document)
  }
}

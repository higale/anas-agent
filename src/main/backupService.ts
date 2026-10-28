import { projectResetEntries, rename, writeRestoreJournal, rollbackRestore, swapRestoredData, recoverInterruptedDataRestoreExcept, enqueueDataReplacement, type RestoreJournal } from './dataReplacement'
export { replaceProjectData } from './dataReplacement'
import { createWriteStream } from 'node:fs'
import { app } from 'electron'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { ZipFile } from 'yazl'
import type { DataBackupResult, DataRestoreResult } from '@shared/types'
import { configDirName, configFileNames, getDataDir, getProgramName } from './config/dataDir'
import { readRawConfig } from './config/rawAppConfig'
import { normalizeAppProfile } from './config/profileConfig'
import { snapshotAgentStorage } from './agent/agentDatabaseBackup'
import {
  backupManifest, backupManifestFileName, extractBackupArchive,
  shouldSkipBackupRelativePath
} from './backupArchive'
import { validateRestoredDataDirectory } from './dataRestoreValidation'
import { runtimeLog } from './runtimeLogger'
import { withApplicationDataSnapshot } from './applicationDataSnapshot'

const requiredRestoreFiles = new Set(configFileNames.map((fileName) => `${configDirName}/${fileName}`))
const windowsReservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const maxBackupNameBytes = 96

function pad(value: number): string {
  return value.toString().padStart(2, '0')
}

function timestamp(date = new Date()): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('')
}

function safeHostName(): string {
  return hostname().replace(/[^\w.-]+/g, '_') || 'host'
}

function canUseFileNameSegment(value: string): boolean {
  if (!value || value === '.' || value === '..') return false
  if (/[<>:"/\\|?*]/.test(value)) return false
  if (Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })) return false
  if (/[. ]$/.test(value)) return false
  if (windowsReservedNames.test(value)) return false
  return Buffer.byteLength(value, 'utf8') <= maxBackupNameBytes
}

async function backupProfileName(): Promise<string> {
  const raw = await readRawConfig()
  const profile = normalizeAppProfile(raw.settings?.profile)
  const assistantName = profile.assistant.name.trim()
  return canUseFileNameSegment(assistantName) ? assistantName : getProgramName()
}

export async function defaultBackupFileName(date = new Date()): Promise<string> {
  return `${safeHostName()}_Anas_${await backupProfileName()}_Backup_${timestamp(date)}.zip`
}

async function preRestoreBackupFileName(date = new Date()): Promise<string> {
  return `_${await defaultBackupFileName(date)}`
}

function ensureZipExtension(path: string): string {
  return path.toLowerCase().endsWith('.zip') ? path : `${path}.zip`
}

function shouldSkipRelativePath(relPath: string): boolean {
  return shouldSkipBackupRelativePath(relPath)
}

function isInsideDirectory(parent: string, child: string): boolean {
  const parentPath = resolve(parent)
  const childPath = resolve(child)
  return childPath === parentPath || childPath.startsWith(`${parentPath}${sep}`)
}

type BackupSourceEntry = { absPath: string; relPath: string; size: number; kind?: 'directory'; linkTarget?: string }

async function collectFiles(root: string, excludePath: string, current = root, includedConversations: ReadonlySet<string> = new Set()): Promise<BackupSourceEntry[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const files: BackupSourceEntry[] = []
  for (const entry of entries) {
    const absPath = join(current, entry.name)
    if (resolve(absPath).toLowerCase() === excludePath.toLowerCase()) continue
    const relPath = relative(root, absPath)
    if (!relPath || shouldSkipRelativePath(relPath)) continue
    const normalizedRelPath = relPath.split(sep).join('/')
    if (normalizedRelPath === backupManifestFileName) continue
    if (/^db\/catalog\.sqlite(?:-(?:wal|shm|journal))?$/i.test(normalizedRelPath)
      || /^db\/conversations\/[^/]+\/conversation\.sqlite(?:-(?:wal|shm|journal))?$/i.test(normalizedRelPath)) continue
    const [directory, collection, ownerId] = normalizedRelPath.split('/')
    if (directory.toLowerCase() === 'db' && collection?.toLowerCase() === 'conversations' && ownerId && !includedConversations.has(ownerId)) continue
    if (entry.isDirectory()) {
      files.push({ absPath, relPath: normalizedRelPath, size: 0, kind: 'directory' })
      files.push(...await collectFiles(root, excludePath, absPath, includedConversations))
    } else if (entry.isSymbolicLink()) {
      // Store self-contained links without traversing them or copying external
      // resources. Resolve chains so restored links do not depend on aliases.
      const target = await realpath(absPath).catch(reason => {
        if (['ENOENT', 'ELOOP'].includes((reason as NodeJS.ErrnoException).code ?? '')) return undefined
        throw reason
      })
      const canonicalRoot = await realpath(root)
      if (target && isInsideDirectory(canonicalRoot, target)) {
        files.push({ absPath, relPath: normalizedRelPath, size: 0, linkTarget: relative(canonicalRoot, target).split(sep).join('/') })
      }
    } else if (entry.isFile()) {
      const info = await stat(absPath)
      files.push({
        absPath,
        relPath: normalizedRelPath,
        size: info.size
      })
    }
  }
  return files
}

export async function createDataBackupZip(targetPath: string): Promise<DataBackupResult> {
  return withApplicationDataSnapshot(() => createDataBackupSnapshot(targetPath))
}

async function createDataBackupSnapshot(targetPath: string): Promise<DataBackupResult> {
  const dataDir = resolve(getDataDir())
  const zipPath = ensureZipExtension(targetPath)
  const resolvedZipPath = resolve(zipPath)
  const snapshotDir = await mkdtemp(join(tmpdir(), 'anas-backup-'))
  try {
    const databaseSnapshots = await snapshotAgentStorage(dataDir, snapshotDir)
    const includedConversations = new Set(databaseSnapshots.flatMap(file => file.conversationIds ?? []))
    const entries: BackupSourceEntry[] = [...await collectFiles(dataDir, resolvedZipPath, dataDir, includedConversations), ...databaseSnapshots]
    const includedTargets = new Set(entries.filter(entry => entry.linkTarget === undefined).map(entry => entry.relPath))
    const files = entries.filter(entry => entry.linkTarget === undefined || includedTargets.has(entry.linkTarget))

    await mkdir(dirname(resolvedZipPath), { recursive: true })
    await new Promise<void>((resolvePromise, reject) => {
      const zip = new ZipFile()
      zip.addBuffer(Buffer.from(`${JSON.stringify(backupManifest)}\n`), backupManifestFileName)
      const output = createWriteStream(resolvedZipPath)
      output.on('close', resolvePromise)
      output.on('error', reject)
      zip.outputStream.on('error', reject)
      zip.outputStream.pipe(output)
      for (const file of files) {
        if (file.kind === 'directory') zip.addEmptyDirectory(file.relPath)
        else if (file.linkTarget !== undefined) {
          const target = relative(dirname(file.relPath), file.linkTarget).split(sep).join('/') || '.'
          zip.addBuffer(Buffer.from(target), file.relPath, { mode: 0o120777 })
        } else zip.addFile(file.absPath, file.relPath)
      }
      zip.end()
    })

    const info = await stat(resolvedZipPath)
    return {
      path: resolvedZipPath,
      backupDir: dirname(resolvedZipPath),
      fileCount: files.filter(file => file.kind !== 'directory').length,
      size: info.size
    }
  } finally {
    await rm(snapshotDir, { recursive: true, force: true })
  }
}

export interface DataRestoreLifecycle {
  deactivate(): Promise<void>
  activate(): Promise<void>
  reactivatePrevious?(): Promise<void>
  finish?(): void
  stateChanged?(state: 'committed' | 'rolled_back', details: { path: string; error?: unknown }): void
}

export function recoverInterruptedDataRestore(): Promise<boolean> {
  return recoverInterruptedDataRestoreExcept(undefined, getDataDir())
}

async function restoreDataBackupZipExclusive(
  sourcePath: string,
  lifecycle?: DataRestoreLifecycle
): Promise<DataRestoreResult> {
  const dataDir = resolve(getDataDir())
  const resolvedSourcePath = resolve(sourcePath)
  const sourceInfo = await stat(resolvedSourcePath)
  await mkdir(dirname(dataDir), { recursive: true })
  const tempRoot = await mkdtemp(join(dirname(dataDir), `.anas-restore-v4-${basename(dataDir)}-`))
  const restoreDir = join(tempRoot, 'staged')
  const journal: RestoreJournal = {
    version: 0,
    dataDir,
    phase: 'staged',
    previousEntries: [],
    installedEntries: []
  }
  let swapped = false
  let cleanupTransaction = true
  let deactivationAttempted = false
  let activationAttempted = false

  try {
    const extracted = await extractBackupArchive(resolvedSourcePath, restoreDir)
    for (const fileName of requiredRestoreFiles) {
      if (!extracted.entryNames.has(fileName)) {
        throw new Error(`Backup archive is missing ${fileName}.`)
      }
    }
    if (!extracted.entryNames.has(backupManifestFileName)) throw new Error('Unsupported backup storage layout; Anas 4.0 or later backup required.')
    const manifest = JSON.parse(await readFile(join(restoreDir, backupManifestFileName), 'utf8'))
    if (!manifest || typeof manifest !== 'object' || manifest.version !== backupManifest.version || manifest.storage_layout !== backupManifest.storage_layout) {
      throw new Error('Unsupported backup storage layout.')
    }
    await rm(join(restoreDir, backupManifestFileName))
    await validateRestoredDataDirectory(restoreDir)
    await writeRestoreJournal(join(tempRoot, 'transaction.json'), journal)

    if (lifecycle) {
      // Mark before awaiting: a failed deactivation may still have closed one
      // of several runtime resources and therefore requires reactivation.
      deactivationAttempted = true
      await lifecycle.deactivate()
    }
    // Interrupted transactions can rename live data and therefore must only
    // be recovered after the current runtime has reached the same quiescent
    // boundary used for the new swap.
    await recoverInterruptedDataRestoreExcept(tempRoot, dataDir)

    const preferredBackupDir = dirname(resolvedSourcePath)
    const preRestoreBackupDir = isInsideDirectory(dataDir, preferredBackupDir) ? tmpdir() : preferredBackupDir
    const preRestoreBackupPath = (await createDataBackupZip(join(preRestoreBackupDir, await preRestoreBackupFileName()))).path
    cleanupTransaction = false
    await swapRestoredData(tempRoot, journal)
    swapped = true
    if (lifecycle) {
      activationAttempted = true
      await lifecycle.activate()
    }
    journal.phase = 'committed'
    await writeRestoreJournal(join(tempRoot, 'transaction.json'), journal)
    cleanupTransaction = true
    try {
      lifecycle?.stateChanged?.('committed', { path: resolvedSourcePath })
    } catch (error) {
      runtimeLog('warn', 'backup', 'A data restore commit observer failed.', { error })
    }
    lifecycle?.finish?.()
    return {
      path: resolvedSourcePath,
      preRestoreBackupPath,
      fileCount: extracted.fileCount - 1,
      size: sourceInfo.size
    }
  } catch (reason) {
    const recoveryFailures: unknown[] = []
    let safeToRollback = true
    if (activationAttempted && lifecycle) {
      try {
        await lifecycle.deactivate()
      } catch (error) {
        safeToRollback = false
        recoveryFailures.push(error)
      }
    }
    const needsRollback = swapped
      || journal.phase === 'swapping'
      || journal.phase === 'activated'
    let rolledBack = !needsRollback
    if (needsRollback && safeToRollback) {
      try {
        await rollbackRestore(tempRoot, journal)
        cleanupTransaction = true
        rolledBack = true
        try {
          lifecycle?.stateChanged?.('rolled_back', { path: resolvedSourcePath, error: reason })
        } catch (error) {
          runtimeLog('warn', 'backup', 'A data restore rollback observer failed.', { error })
        }
      } catch (error) {
        recoveryFailures.push(error)
      }
    }
    if (deactivationAttempted && rolledBack && lifecycle) {
      try {
        await (lifecycle.reactivatePrevious ?? lifecycle.activate)()
      } catch (error) {
        recoveryFailures.push(error)
      }
    }
    if (recoveryFailures.length > 0) {
      throw new AggregateError(
        [reason, ...recoveryFailures],
        rolledBack
          ? 'Data restore failed and the previous runtime could not be reactivated.'
          : 'Data restore failed and its transaction could not be rolled back safely.'
      )
    }
    if (deactivationAttempted && rolledBack) lifecycle?.finish?.()
    throw reason
  } finally {
    if (cleanupTransaction) {
      await rm(tempRoot, { recursive: true, force: true }).catch((error) => {
        runtimeLog('warn', 'backup', 'Failed to remove a finished data restore transaction.', {
          path: tempRoot,
          error
        })
      })
    }
  }
}

export function restoreDataBackupZip(
  sourcePath: string,
  lifecycle?: DataRestoreLifecycle
): Promise<DataRestoreResult> {
  return enqueueDataReplacement(() => restoreDataBackupZipExclusive(sourcePath, lifecycle))
}

// Uses the restore journal so a crash cannot leave old project metadata paired
// with a new database (or the reverse). Call only with all data writers stopped.
export function resetProjectData(preserveCurrentData: () => Promise<string>): Promise<string> {
  return enqueueDataReplacement(async () => {
    await recoverInterruptedDataRestore()
    const dataDir = resolve(getDataDir())
    const databaseDir = await lstat(join(dataDir, 'db')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (databaseDir && !databaseDir.isDirectory()) throw new Error('Cannot reset project data through a linked or invalid database directory.')
    const previousEntries: string[] = []
    for (const target of projectResetEntries) {
      try {
        const info = await lstat(join(dataDir, target))
        if (target === 'db/conversations' ? !info.isDirectory() : !info.isFile()) {
          throw new Error(`Cannot reset a linked or invalid project data entry: ${join(dataDir, target)}`)
        }
        previousEntries.push(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const preservationPath = await preserveCurrentData()
    const transactionRoot = await mkdtemp(join(dirname(dataDir), `.anas-restore-v4-${basename(dataDir)}-`))
    const journalPath = join(transactionRoot, 'transaction.json')
    const journal: RestoreJournal = { version: 0, dataDir, phase: 'staged', previousEntries, installedEntries: [] }
    let cleanup = true
    try {
      await mkdir(join(transactionRoot, 'previous', 'db'), { recursive: true })
      await writeRestoreJournal(journalPath, journal)
      journal.phase = 'swapping'
      await writeRestoreJournal(journalPath, journal)
      cleanup = false
      for (const target of previousEntries) {
        await rename(join(dataDir, target), join(transactionRoot, 'previous', target))
      }
      // Normal initialization creates a default project and empty database on
      // restart. No damaged JSON or SQLite file needs to be opened for the reset.
      journal.phase = 'committed'
      await writeRestoreJournal(journalPath, journal)
      cleanup = true
      return preservationPath
    } catch (error) {
      if (!cleanup) {
        try {
          await rollbackRestore(transactionRoot, journal)
          cleanup = true
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Project data reset failed and could not be rolled back safely.')
        }
      }
      throw error
    } finally {
      if (cleanup) await rm(transactionRoot, { recursive: true, force: true }).catch((error) => {
        runtimeLog('warn', 'recovery', 'Could not remove a finished project reset transaction.', { path: transactionRoot, error })
      })
    }
  })
}

export function defaultBackupDirectory(): string {
  return app.getPath('documents')
}

export async function backupDialogDefaultPath(backupDirectory?: string): Promise<string> {
  return join(backupDirectory || defaultBackupDirectory(), await defaultBackupFileName())
}

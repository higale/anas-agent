import { lstat, opendir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { AppDataStorageUsageSnapshot, StorageUsageValue } from '@shared/types'
import { getDataDir, inputHistoryFileName } from './config/dataDir'
import { readInputHistoryStoreFile } from './inputHistoryStore'
import { dataCleanupDisposition } from './unknownDataCleanup'

const statConcurrency = 32

interface DataDirectoryTotals {
  cache: number
  developerHttpTrace: number
  inputHistory: number
  log: number
  temp: number
  total: number
  unknown: number
  unknownPaths: string[]
  present: Set<string>
}

export interface DataStorageUsageDependencies {
  dataDir?: string
  electronCacheSize?: () => Promise<number>
}

function isMissingPath(reason: unknown): boolean {
  return Boolean(
    reason
    && typeof reason === 'object'
    && 'code' in reason
    && (reason as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function addBytes(current: number, bytes: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + Math.max(0, bytes))
}

function usage(totalBytes: number, approximate = false): StorageUsageValue {
  return { totalBytes, approximate }
}

interface StorageEntry { path: string; parts: string[]; unknown: boolean; unknownRoot: boolean }

async function* dataDirectoryFiles(root: string): AsyncGenerator<StorageEntry> {
  const pendingDirectories = [{ path: root, unknown: false, keep: false }]
  while (pendingDirectories.length > 0) {
    const current = pendingDirectories.pop()!
    const directoryPath = current.path
    let directory
    try {
      const info = await lstat(directoryPath)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      directory = await opendir(directoryPath)
    } catch (reason) {
      if (isMissingPath(reason)) continue
      throw reason
    }
    try {
      for await (const entry of directory) {
        const path = join(directoryPath, entry.name)
        const parts = relative(root, path).split(/[\\/]/)
        const disposition = current.unknown ? 'unknown' : current.keep ? 'keep' : dataCleanupDisposition(parts.join('/'))
        const unknown = disposition === 'unknown'
        yield { path, parts, unknown, unknownRoot: unknown && !current.unknown }
        if (entry.isDirectory()) {
          pendingDirectories.push({ path, unknown, keep: disposition === 'keep' })
        }
      }
    } catch (reason) {
      if (!isMissingPath(reason)) throw reason
    }
  }
}

async function measureFiles(
  files: StorageEntry[],
  totals: DataDirectoryTotals
): Promise<void> {
  const measured = await Promise.all(files.map(async (file) => {
    try {
      const info = await lstat(file.path)
      return { bytes: info.isFile() ? info.size : 0, directory: info.isDirectory() }
    } catch (reason) {
      if (isMissingPath(reason)) return undefined
      throw reason
    }
  }))
  for (let index = 0; index < files.length; index += 1) {
    const measurement = measured[index]
    if (!measurement) continue
    const bytes = measurement.bytes
    const parts = files[index]!.parts
    if (parts.length > 1) totals.present.add(parts[0])
    if (parts[0] === 'dev' && parts[1] === 'model-http' && parts.length > 2) totals.present.add('developerHttpTrace')
    if (files[index].unknown) totals.unknown = addBytes(totals.unknown, bytes)
    if (files[index].unknownRoot) totals.unknownPaths.push(parts.join('/') + (measurement.directory ? '/' : ''))
    totals.total = addBytes(totals.total, bytes)
    if (parts[0] === 'cache') totals.cache = addBytes(totals.cache, bytes)
    if (parts[0] === 'tmp') totals.temp = addBytes(totals.temp, bytes)
    if (parts[0] === 'log') totals.log = addBytes(totals.log, bytes)
    if (parts[0] === 'dev' && parts[1] === 'model-http') {
      totals.developerHttpTrace = addBytes(totals.developerHttpTrace, bytes)
    }
    if (parts.length === 2 && parts[0] === 'db' && parts[1] === inputHistoryFileName) {
      totals.inputHistory = addBytes(totals.inputHistory, bytes)
    }
  }
}

async function scanDataDirectory(root: string): Promise<DataDirectoryTotals> {
  const totals: DataDirectoryTotals = {
    cache: 0,
    developerHttpTrace: 0,
    inputHistory: 0,
    log: 0,
    temp: 0,
    total: 0,
    unknown: 0,
    unknownPaths: [],
    present: new Set()
  }
  let batch: StorageEntry[] = []
  for await (const file of dataDirectoryFiles(root)) {
    batch.push(file)
    if (batch.length === statConcurrency) {
      await measureFiles(batch, totals)
      batch = []
    }
  }
  if (batch.length > 0) await measureFiles(batch, totals)
  return totals
}

export async function measureDirectorySize(root: string): Promise<number> {
  return (await scanDataDirectory(root)).total
}

export async function getDeveloperHttpTraceUsage(
  dependencies: Pick<DataStorageUsageDependencies, 'dataDir'> = {}
): Promise<StorageUsageValue> {
  return usage(await measureDirectorySize(join(dependencies.dataDir ?? getDataDir(), 'dev', 'model-http')))
}

export async function getDataStorageUsage(
  dependencies: DataStorageUsageDependencies = {}
): Promise<AppDataStorageUsageSnapshot> {
  const totals = await scanDataDirectory(dependencies.dataDir ?? getDataDir())
  let electronCacheBytes = 0
  let electronCacheKnown = false
  try {
    const measured = await dependencies.electronCacheSize?.()
    electronCacheKnown = measured !== undefined && Number.isFinite(measured) && measured >= 0
    if (electronCacheKnown) electronCacheBytes = measured!
  } catch {
    // The application cache remains useful even when Chromium cannot report its cache size.
  }
  let inputHistoryHasData: boolean | undefined
  try {
    const history = await readInputHistoryStoreFile(join(dependencies.dataDir ?? getDataDir(), 'db', inputHistoryFileName))
    inputHistoryHasData = history.items.some(item => !item.pinned)
  } catch (reason) {
    if (isMissingPath(reason)) inputHistoryHasData = false
  }
  return {
    dataDirectory: usage(totals.total),
    developerHttpTrace: usage(totals.developerHttpTrace),
    cleanup: {
      input_history: { ...usage(totals.inputHistory), hasData: inputHistoryHasData },
      cache_folder: { ...usage(addBytes(totals.cache, electronCacheBytes), true),
        hasData: totals.present.has('cache') || electronCacheBytes > 0 ? true : electronCacheKnown ? false : undefined },
      temp_folder: { ...usage(totals.temp), hasData: totals.present.has('tmp') },
      log_folder: { ...usage(totals.log), hasData: totals.present.has('log') },
      developer_http_trace: { ...usage(totals.developerHttpTrace), hasData: totals.present.has('developerHttpTrace') },
      unknown_files: { ...usage(totals.unknown), hasData: totals.unknownPaths.length > 0 }
    },
    unknownFiles: totals.unknownPaths.sort()
  }
}

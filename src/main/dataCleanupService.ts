import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getCacheDir, getDataDir, getDeveloperHttpTraceDir, getLogDir, getTempDir } from './config/dataDir'
import { clearInputHistory } from './inputHistoryStore'
import { cleanupUnknownData } from './unknownDataCleanup'
import { withApplicationDataSnapshot } from './applicationDataSnapshot'
import type { DataCleanupRequest, DataCleanupResult, DataCleanupResultItem, DataCleanupTarget } from '@shared/types'

type CleanupAction = () => Promise<{ path?: string }>

export interface DataCleanupDependencies {
  clearElectronCache: () => Promise<void>
}

const defaultDependencies: DataCleanupDependencies = {
  clearElectronCache: async () => undefined
}

const cleanupTargets: DataCleanupTarget[] = [
  'input_history',
  'cache_folder',
  'temp_folder',
  'log_folder',
  'developer_http_trace',
  'unknown_files'
]

function cleanupDirectory(path: string): Promise<{ path: string }> {
  return rm(path, { recursive: true, force: true }).then(() => ({ path }))
}

async function cleanupDirectoryContents(path: string): Promise<{ path: string }> {
  await mkdir(path, { recursive: true })
  const entries = await readdir(path, { withFileTypes: true })
  await Promise.all(entries.map((entry) => rm(join(path, entry.name), { recursive: true, force: true })))
  await mkdir(path, { recursive: true })
  return { path }
}

function cleanupAction(
  target: Exclude<DataCleanupTarget, 'unknown_files'>,
  dependencies: DataCleanupDependencies
): CleanupAction {
  if (target === 'input_history') return async () => {
    await clearInputHistory()
    return {}
  }
  if (target === 'cache_folder') return async () => {
    const path = getCacheDir()
    await cleanupDirectory(path)
    await dependencies.clearElectronCache()
    return { path }
  }
  if (target === 'temp_folder') return () => cleanupDirectory(getTempDir())
  if (target === 'log_folder') return () => cleanupDirectoryContents(getLogDir())
  return () => cleanupDirectory(getDeveloperHttpTraceDir())
}

function selectedTargets(request: DataCleanupRequest): DataCleanupTarget[] {
  return cleanupTargets.filter((target) => request[target] === true)
}

async function cleanupSelectedData(
  request: DataCleanupRequest,
  dependencies: DataCleanupDependencies
): Promise<DataCleanupResult> {
  const items: DataCleanupResultItem[] = []
  for (const target of selectedTargets(request)) {
    try {
      const result = target === 'unknown_files'
        ? await cleanupUnknownData(getDataDir(), request.unknown_file_paths).then(() => ({ path: getDataDir() }))
        : await cleanupAction(target, dependencies)()
      items.push({
        target,
        path: result.path,
        ok: true,
        skipped: false
      })
    } catch (reason) {
      items.push({
        target,
        ok: false,
        error: reason instanceof Error ? reason.message : String(reason)
      })
    }
  }
  return { items }
}

export function cleanupData(
  request: DataCleanupRequest,
  dependencies: DataCleanupDependencies = defaultDependencies
): Promise<DataCleanupResult> {
  return withApplicationDataSnapshot(() => cleanupSelectedData(request, dependencies))
}

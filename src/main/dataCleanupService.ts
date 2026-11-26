import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isSameOrInsideDirectory, samePath } from './pathContainment'
import { guardCleanupDirectory } from './cleanupDirectoryGuard'
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

async function cleanupDirectory(path: string): Promise<{ path: string }> {
  const root = await realpath(getDataDir())
  const target = resolve(root, relative(resolve(getDataDir()), resolve(path)))
  if (samePath(root, target) || !isSameOrInsideDirectory(root, target)) throw new Error('Cleanup target is outside the data directory.')
  const guards = [await guardCleanupDirectory(root)]
  let parent = root
  for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    parent = join(parent, part)
    try { guards.push(await guardCleanupDirectory(parent)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path }
      throw error
    }
  }
  for (const verify of guards) await verify()
  await rm(target, { recursive: true, force: true })
  return { path }
}

async function cleanupDirectoryContents(path: string): Promise<{ path: string }> {
  const root = await realpath(getDataDir())
  const target = resolve(root, relative(resolve(getDataDir()), resolve(path)))
  if (!samePath(dirname(target), root)) throw new Error('Log cleanup target is outside the data directory.')
  let original = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (!original) {
    await mkdir(target)
    original = await lstat(target)
  }
  const verify = await guardCleanupDirectory(target, original)
  const entries = await readdir(target, { withFileTypes: true })
  for (const entry of entries) {
    await verify()
    await rm(join(target, entry.name), { recursive: true, force: true })
  }
  await verify()
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

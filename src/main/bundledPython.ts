import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, cp, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import manifest from '../../build/python-runtime.json'
import { getDataDir } from './config/dataDir'
import { withApplicationDataMutation } from './applicationDataSnapshot'
import { runApplicationDataOperation } from './applicationDataLifecycle'
import { runtimeLog } from './runtimeLogger'
import { probePython3, type RuntimeProbeOptions } from './runtimeDiscovery'
import type { PythonRuntimeStatus } from '@shared/types'

function pythonLocations() {
  // Node-only tests and utilities do not install into a user's data directory.
  if (!app?.getAppPath) return undefined
  const target = `${process.platform}-${process.arch}`
  if (!(target in manifest.targets)) return undefined
  const source = app.isPackaged
    ? join(process.resourcesPath, 'runtime', 'python')
    : join(app.getAppPath(), 'build', 'python-runtime', target, 'python')
  const dataDir = getDataDir()
  const destination = join(dataDir, 'runtimes', 'python', manifest.version)
  const entry = process.platform === 'win32' ? 'python.exe' : 'bin/python3'
  if (!existsSync(join(source, entry)) && !existsSync(destination)) return undefined
  return { source, destination, entry, dataDir }
}

export interface BundledPythonInfo {
  executable: string
  version: string
  state: 'installed' | 'preparing' | 'unavailable'
}

/** Read-only metadata for initial context; neither extracts nor probes an interpreter. */
export function getBundledPythonInfo(): BundledPythonInfo | undefined {
  const paths = pythonLocations()
  if (!paths) return undefined
  const executable = join(paths.destination, paths.entry)
  return { executable, version: manifest.version, state: existsSync(executable) ? 'installed'
    : startupStatus.state === 'idle' || startupStatus.state === 'preparing' ? 'preparing' : 'unavailable' }
}

/** Called only after system discovery fails; never prepares or waits for the runtime. */
export async function discoverBundledPython(options: RuntimeProbeOptions = {}) {
  options.signal?.throwIfAborted()
  const info = getBundledPythonInfo()
  return info?.state === 'installed' ? probePython3(info.executable, [], options) : undefined
}

const installations = new Map<string, Promise<void>>()
let startupStatus: PythonRuntimeStatus = { state: 'idle' }
let startupPreparation: Promise<void> | undefined

export function getPythonRuntimeStatus(): PythonRuntimeStatus {
  return { ...startupStatus }
}

/** Optional runtime preparation must never reject the application startup chain. */
export function initializeBundledPython(): Promise<void> {
  if (startupPreparation) return startupPreparation
  startupStatus = { state: 'preparing' }
  startupPreparation = runApplicationDataOperation(() => ensureBundledPython()).then(runtime => {
    startupStatus = { state: runtime ? 'ready' : 'unavailable' }
  }).catch(error => {
    startupStatus = { state: 'error', error: error instanceof Error ? error.message : String(error) }
    runtimeLog('warn', 'runtime', 'Failed to prepare bundled Python at startup.', { error })
  })
  return startupPreparation
}

export async function ensureBundledPython(signal?: AbortSignal) {
  return prepareBundledPython(false, signal)
}

/** Explicit settings action: replace only this version, after preparing a full copy. */
export async function resetBundledPython(): Promise<void> {
  if (startupStatus.state === 'preparing') throw new Error('Bundled Python is still being prepared. Please wait for it to finish.')
  startupStatus = { state: 'preparing' }
  try {
    const runtime = await runApplicationDataOperation(() => prepareBundledPython(true))
    if (!runtime) throw new Error('This application has no bundled Python payload to restore.')
    startupStatus = { state: 'ready' }
  } catch (error) {
    startupStatus = { state: 'error', error: error instanceof Error ? error.message : String(error) }
    runtimeLog('warn', 'runtime', 'Failed to reset bundled Python.', { error })
    throw error
  }
}

async function prepareBundledPython(reset: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const paths = pythonLocations()
  if (!paths) return undefined
  const { source, destination, entry, dataDir } = paths
  let pending = installations.get(destination)
  if (!pending) {
    pending = withApplicationDataMutation(async () => {
      try {
        await lstat(destination)
        // Automatic preparation never replaces an existing mutable environment.
        if (!reset) {
          await access(join(destination, entry), constants.X_OK).catch(() => {
            throw new Error(`Python runtime is incomplete at ${destination}. Use Settings > Environment > Reset bundled Python to restore it.`)
          })
          return
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const temporaryRoot = join(dataDir, 'tmp')
      await mkdir(temporaryRoot, { recursive: true })
      await mkdir(dirname(destination), { recursive: true })
      const stage = await mkdtemp(join(temporaryRoot, 'python-release-'))
      try {
        const stagedPython = join(stage, 'python')
        await cp(source, stagedPython, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true })
        await access(join(stagedPython, entry), constants.X_OK)
        const previous = join(dirname(destination), `${manifest.version}.reset-${randomUUID()}`)
        let moved = false
        if (reset) {
          try {
            await rename(destination, previous)
            moved = true
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        try {
          await rename(stagedPython, destination)
        } catch (error) {
          if (moved) {
            try {
              await rename(previous, destination)
            } catch (rollbackError) {
              // Keep the old environment outside tmp so startup cleanup cannot remove it.
              throw new AggregateError([error, rollbackError], `Python reset failed; the previous environment is preserved at ${previous}.`)
            }
          }
          throw error
        }
        if (moved) await rm(previous, { recursive: true, force: true }).catch(error => {
          runtimeLog('warn', 'runtime', 'Python reset completed, but the previous environment could not be removed.', { previous, error })
        })
      } finally {
        await rm(stage, { recursive: true, force: true })
      }
    }).finally(() => { installations.delete(destination) })
    installations.set(destination, pending)
  }
  await pending
  signal?.throwIfAborted()
  const executable = join(destination, entry)
  return { executable, version: manifest.version }
}

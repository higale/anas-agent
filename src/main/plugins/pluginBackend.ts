import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { requirePluginId, requirePluginJson, type PluginSummary } from '@shared/plugins'
import type { PluginStore } from './pluginStore'

interface BackendInstance {
  process: UtilityProcess
  ready: Promise<void>
  exited: Promise<void>
  stopping: boolean
  activeId?: number
  stopError?: Error
  pending: Map<number, { method: string; params: unknown; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>
}

export class PluginBackends {
  private instances = new Map<string, BackendInstance>()
  private statuses = new Map<string, Pick<PluginSummary, 'backendStatus' | 'backendError'>>()
  private sequence = 0
  constructor(private store: PluginStore, private changed: () => void, private timeoutMs = 30_000) {}

  status(id: string): Pick<PluginSummary, 'backendStatus' | 'backendError'> {
    return this.statuses.get(id) ?? { backendStatus: 'stopped' }
  }

  async start(id: string): Promise<void> {
    await (await this.prepare(id)).ready
  }

  async prepare(id: string): Promise<BackendInstance> {
    const existing = this.instances.get(id)
    if (existing) {
      if (existing.stopping) throw new Error('Plugin backend is stopping.')
      return existing
    }
    const manifest = await this.store.requireEnabled(id)
    if (!manifest.backend) throw new Error('Plugin has no backend entry.')
    const [entry, packageDirectory, dataDirectory] = await Promise.all([
      this.store.packageFile(id, manifest.backend), this.store.packageDirectory(id), this.store.directory('plugins_data', id, true)
    ])
    // Another caller can finish the asynchronous package checks first.
    const concurrent = this.instances.get(id)
    if (concurrent) {
      if (concurrent.stopping) throw new Error('Plugin backend is stopping.')
      return concurrent
    }
    const child = utilityProcess.fork(join(__dirname, 'pluginWorker.js'), [entry, JSON.stringify({ pluginId: id, packageDirectory, dataDirectory })], {
      cwd: packageDirectory, stdio: 'pipe', serviceName: `Anas plugin: ${id}`
    })
    child.stdout?.resume()
    child.stderr?.resume()
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    void ready.catch(() => undefined)
    let resolveExit!: () => void
    const exited = new Promise<void>(resolve => { resolveExit = resolve })
    const instance: BackendInstance = { process: child, ready, exited, stopping: false, pending: new Map() }
    this.instances.set(id, instance)
    this.statuses.set(id, { backendStatus: 'starting' })
    this.changed()
    const fail = (error: Error) => {
      rejectReady(error)
      for (const pending of instance.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
      instance.pending.clear()
      this.statuses.set(id, { backendStatus: 'failed', backendError: error.message })
      instance.stopping = true
      child.kill()
      this.changed()
    }
    const startupTimer = setTimeout(() => fail(new Error('Plugin backend startup timed out.')), this.timeoutMs)
    child.on('message', (message: { ready?: boolean; id?: number; result?: unknown; error?: string; stopError?: string }) => {
      if (instance.stopping && typeof message.stopError === 'string') {
        instance.stopError = new Error(`Plugin backend cleanup failed: ${message.stopError}`)
        return
      }
      if (typeof message.ready === 'boolean') {
        clearTimeout(startupTimer)
        if (instance.stopping) return
        if (!message.ready) { fail(new Error(message.error ?? 'Plugin backend failed to start.')); return }
        this.statuses.set(id, { backendStatus: 'running' })
        resolveReady()
        this.changed()
        return
      }
      if (typeof message.id !== 'number' || message.id !== instance.activeId) return
      const pending = instance.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      instance.pending.delete(message.id)
      instance.activeId = undefined
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.result)
      this.dispatch(instance)
    })
    child.once('exit', (code) => {
      clearTimeout(startupTimer)
      const error = new Error(instance.stopping ? 'Plugin backend stopped.' : `Plugin backend exited (${code}).`)
      rejectReady(error)
      for (const pending of instance.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
      instance.pending.clear()
      this.instances.delete(id)
      if (!instance.stopping) this.statuses.set(id, { backendStatus: 'failed', backendError: error.message })
      resolveExit()
      this.changed()
    })
    return instance
  }

  async call(id: string, method: unknown, params: unknown, prepared?: BackendInstance): Promise<unknown> {
    if (typeof method !== 'string' || !method || method.length > 120) throw new Error('Invalid plugin backend method.')
    requirePluginJson(params ?? null)
    const instance = this.instances.get(id)
    if (!instance || instance.stopping || (prepared && prepared !== instance)) throw new Error('Plugin backend is unavailable.')
    if (instance.pending.size >= 32) throw new Error('Too many pending plugin requests.')
    const requestId = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('Plugin backend request timed out; backend was terminated.')
        this.statuses.set(id, { backendStatus: 'failed', backendError: error.message })
        instance.stopping = true
        for (const pending of instance.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
        instance.pending.clear()
        instance.process.kill()
        this.changed()
      }, this.timeoutMs)
      instance.pending.set(requestId, { method, params: params ?? null, resolve, reject, timer })
      this.dispatch(instance)
    })
  }

  private dispatch(instance: BackendInstance): void {
    if (instance.stopping || instance.activeId !== undefined) return
    const next = instance.pending.entries().next().value
    if (!next) return
    const [id, pending] = next
    instance.activeId = id
    try { instance.process.postMessage({ id, method: pending.method, params: pending.params }) } catch (error) {
      clearTimeout(pending.timer)
      instance.pending.delete(id)
      instance.activeId = undefined
      pending.reject(error instanceof Error ? error : new Error(String(error)))
      this.dispatch(instance)
    }
  }

  async stop(id: string): Promise<void> {
    requirePluginId(id)
    const instance = this.instances.get(id)
    if (instance) {
      instance.stopping = true
      for (const [requestId, pending] of instance.pending) {
        if (requestId === instance.activeId) continue
        clearTimeout(pending.timer)
        pending.reject(new Error('Plugin backend stopped before this request started.'))
        instance.pending.delete(requestId)
      }
      try { instance.process.postMessage({ stop: true }) } catch { instance.process.kill() }
      const timer = setTimeout(() => instance.process.kill(), 3000)
      try { await instance.exited } finally { clearTimeout(timer) }
      if (instance.stopError) {
        this.statuses.set(id, { backendStatus: 'failed', backendError: instance.stopError.message })
        this.changed()
        throw instance.stopError
      }
    }
    this.statuses.set(id, { backendStatus: 'stopped' })
    this.changed()
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.instances.keys()].map(id => this.stop(id)))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Could not cleanly stop all plugin backends.')
  }
}

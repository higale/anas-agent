import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { requirePluginId, requirePluginJson, type PluginSummary, type PluginBackendCallContext } from '@shared/plugins'
import type { PluginStore } from './pluginStore'

interface PendingCall {
  method: string
  params: unknown
  context?: () => PluginBackendCallContext
  tool?: { deadline: number }
  dispatched: boolean
  cancellation?: Error
  dispose(): void
  resolve(value: unknown): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
}

export class PluginCallError extends Error {
  constructor(message: string, readonly code: 'unavailable' | 'cancelled' | 'timeout' | 'unknown_effect' | 'handler_error' | 'result_error', readonly dispatched: boolean) { super(message) }
}

interface BackendInstance {
  process: UtilityProcess
  ready: Promise<void>
  exited: Promise<void>
  stopping: boolean
  activeId?: number
  stopError?: Error
  pending: Map<number, PendingCall>
}

export type PluginViewAction = (id: string, method: 'openView' | 'moveView', params: unknown, assertAvailable: () => void) => Promise<unknown>

export class PluginBackends {
  private instances = new Map<string, BackendInstance>()
  private statuses = new Map<string, Pick<PluginSummary, 'backendStatus' | 'backendError'>>()
  private sequence = 0
  constructor(private store: PluginStore, private changed: () => void, private timeoutMs = 30_000, private stopGraceMs = 3_000,
    private readViews?: (id: string) => PluginBackendCallContext['views'], private viewAction?: PluginViewAction) {}

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
    const child = utilityProcess.fork(join(app.getAppPath(), 'out/main/pluginWorker.js'), [entry, JSON.stringify({ pluginId: id, packageDirectory, dataDirectory })], {
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
      for (const pending of instance.pending.values()) { clearTimeout(pending.timer); pending.dispose(); pending.reject(new PluginCallError(pending.cancellation?.message ?? error.message, pending.dispatched ? 'unknown_effect' : 'unavailable', pending.dispatched)) }
      instance.pending.clear()
      this.statuses.set(id, { backendStatus: 'failed', backendError: error.message })
      instance.stopping = true
      child.kill()
      this.changed()
    }
    const startupTimer = setTimeout(() => fail(new Error('Plugin backend startup timed out.')), this.timeoutMs)
    child.on('message', (message: { ready?: boolean; id?: number; result?: unknown; error?: string; stopError?: string; resultError?: boolean; hostRequest?: number; method?: string; params?: unknown }) => {
      if (typeof message.hostRequest === 'number') {
        void (async () => {
          const assertAvailable = () => {
            if (instance.stopping || this.instances.get(id) !== instance) throw new Error('Plugin host service is unavailable.')
          }
          assertAvailable()
          requirePluginJson(message.params ?? null)
          const result = message.method === 'getViews' && this.readViews ? this.readViews(id)
            : message.method === 'getSettings' ? await this.store.exclusive(async () => {
              if (instance.stopping || this.instances.get(id) !== instance) throw new Error('Plugin backend is unavailable.')
              return (await this.store.settings(id)).values
            }) : (message.method === 'openView' || message.method === 'moveView') && this.viewAction
              ? await this.viewAction(id, message.method, message.params, assertAvailable) : undefined
          if (result === undefined || instance.stopping) throw new Error('Plugin host service is unavailable.')
          requirePluginJson(result)
          child.postMessage({ hostResponse: message.hostRequest, result })
        })().catch(error => {
          try { child.postMessage({ hostResponse: message.hostRequest, error: error instanceof Error ? error.message : String(error) }) } catch { /* Process already exited. */ }
        })
        return
      }
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
      if (typeof message.id !== 'number') return
      const pending = instance.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      instance.pending.delete(message.id)
      pending.dispose()
      if (message.id === instance.activeId) instance.activeId = undefined
      if (message.error) pending.reject(new PluginCallError(message.error, message.resultError ? 'result_error' : pending.cancellation ? 'unknown_effect' : 'handler_error', true))
      else pending.resolve(message.result)
      this.dispatch(instance)
    })
    child.once('exit', (code) => {
      clearTimeout(startupTimer)
      if (instance.stopping && code !== 0) instance.stopError ??= new Error(`Plugin backend exited before cleanup completed (${code}).`)
      const error = new Error(instance.stopping ? 'Plugin backend stopped.' : `Plugin backend exited (${code}).`)
      rejectReady(error)
      for (const pending of instance.pending.values()) { clearTimeout(pending.timer); pending.dispose(); pending.reject(new PluginCallError(pending.cancellation?.message ?? error.message, pending.dispatched ? 'unknown_effect' : 'unavailable', pending.dispatched)) }
      instance.pending.clear()
      this.instances.delete(id)
      if (!instance.stopping) this.statuses.set(id, { backendStatus: 'failed', backendError: error.message })
      resolveExit()
      this.changed()
    })
    return instance
  }

  async call(id: string, method: unknown, params: unknown, prepared?: BackendInstance, context?: () => PluginBackendCallContext): Promise<unknown> {
    return this.request(id, method, params, prepared, { context })
  }

  async tool(id: string, handler: string, params: unknown, prepared: BackendInstance, options: {
    timeoutMs: number; signal?: AbortSignal; onDispatch(): void
  }): Promise<unknown> {
    return this.request(id, handler, params, prepared, { ...options, tool: true })
  }

  private request(id: string, method: unknown, params: unknown, prepared: BackendInstance | undefined, options: {
    context?: () => PluginBackendCallContext; tool?: boolean; timeoutMs?: number; signal?: AbortSignal; onDispatch?(): void
  }): Promise<unknown> {
    if (typeof method !== 'string' || !method || method.length > 120) return Promise.reject(new Error('Invalid plugin backend method.'))
    requirePluginJson(params ?? null)
    const instance = this.instances.get(id)
    if (!instance || instance.stopping || (prepared && prepared !== instance)) return Promise.reject(new PluginCallError('Plugin backend is unavailable.', 'unavailable', false))
    if (instance.pending.size >= 32) return Promise.reject(new PluginCallError('Too many pending plugin requests.', 'unavailable', false))
    if (options.signal?.aborted) return Promise.reject(new PluginCallError('Plugin request cancelled before dispatch.', 'cancelled', false))
    const requestId = ++this.sequence
    return new Promise((resolve, reject) => {
      const timeout = options.timeoutMs ?? this.timeoutMs
      const cancel = (reason: 'cancelled' | 'timeout') => {
        const pending = instance.pending.get(requestId)
        if (!pending || (pending.cancellation && reason === 'cancelled')) return
        const error = new PluginCallError(reason === 'timeout' ? 'Plugin request timed out.' : 'Plugin request cancelled.', reason, pending.dispatched)
        pending.cancellation ??= error
        if (!pending.dispatched) {
          clearTimeout(pending.timer)
          instance.pending.delete(requestId)
          pending.dispose()
          reject(error)
          return
        }
        // A request deadline asks only this handler to stop. The backend owns shared
        // resources; never kill it because one handler is slow or ignores cancellation.
        // Retain the in-flight slot, RPC ordering and actual late receipt until the
        // handler settles, the process exits, or the user explicitly stops the plugin.
        try { instance.process.postMessage({ cancel: requestId, reason }) } catch {
          // A failed cancellation message is not proof the accepted work stopped.
          // Keep waiting for its original receipt or the process exit notification.
        }
      }
      const onAbort = () => cancel('cancelled')
      const pending: PendingCall = { method, params: params ?? null, context: options.context,
        tool: options.tool ? { deadline: Date.now() + timeout } : undefined,
        dispatched: false, resolve, reject, dispose: () => options.signal?.removeEventListener('abort', onAbort) }
      instance.pending.set(requestId, pending)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      pending.timer = setTimeout(() => cancel('timeout'), timeout)
      if (pending.tool) this.send(instance, requestId, pending, options.onDispatch)
      else this.dispatch(instance)
    })
  }

  private send(instance: BackendInstance, id: number, pending: PendingCall, onDispatch?: () => void): void {
    try {
      const context = pending.tool ?? pending.context?.() ?? { caller: null, views: [] }
      onDispatch?.()
      if (!instance.pending.has(id) || instance.stopping) return
      instance.process.postMessage({ id, method: pending.method, params: pending.params, context,
        ...(pending.tool ? { tool: true } : {}) })
      pending.dispatched = true
    } catch (error) {
      clearTimeout(pending.timer)
      pending.dispose()
      instance.pending.delete(id)
      if (id === instance.activeId) instance.activeId = undefined
      pending.reject(error instanceof Error ? error : new Error(String(error)))
      this.dispatch(instance)
    }
  }

  private dispatch(instance: BackendInstance): void {
    if (instance.stopping || instance.activeId !== undefined) return
    const next = [...instance.pending].find(([, pending]) => !pending.tool && !pending.dispatched)
    if (!next) return
    instance.activeId = next[0]
    this.send(instance, next[0], next[1])
  }

  async stop(id: string): Promise<void> {
    requirePluginId(id)
    const instance = this.instances.get(id)
    if (instance) {
      instance.stopping = true
      for (const [requestId, pending] of instance.pending) {
        if (pending.dispatched) {
          try { instance.process.postMessage({ cancel: requestId, reason: 'stopped' }) } catch { instance.process.kill() }
          continue
        }
        clearTimeout(pending.timer)
        pending.dispose()
        pending.reject(new PluginCallError('Plugin backend stopped before this request started.', 'unavailable', false))
        instance.pending.delete(requestId)
      }
      try { instance.process.postMessage({ stop: true }) } catch { instance.process.kill() }
      const timer = setTimeout(() => { instance.stopError = new Error('Plugin backend cleanup timed out.'); instance.process.kill() }, this.stopGraceMs)
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

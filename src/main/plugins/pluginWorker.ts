import { createRequire } from 'node:module'
import { requirePluginJson, type PluginBackendCallContext } from '@shared/plugins'
import type { PluginToolContext, PluginBackendHost } from '@shared/pluginTools'
import { validatePluginToolResult } from './pluginToolResult'

const port = process.parentPort!
const load = createRequire(__filename)
interface PluginBackend {
  activate?(context: { pluginId: string; packageDirectory: string; dataDirectory: string; host: PluginBackendHost }): unknown
  call?(method: string, params: unknown, context: PluginBackendCallContext & { signal: AbortSignal }): unknown
  tools?: Record<string, (params: unknown, context: PluginToolContext) => unknown>
  deactivate?(): unknown
}
interface Request {
  id: number
  method: string
  params?: unknown
  context: PluginBackendCallContext | Omit<PluginToolContext, 'signal' | 'host'>
  tool?: boolean
  hostResponse?: number
  result?: unknown
  error?: string
  stop?: boolean
  cancel?: number
  reason?: string
}
let backend: PluginBackend
const running = new Map<number, { controller: AbortController; done: Promise<void> }>()
const hostRequests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
let hostSequence = 0
let stopping = false

function host(signal?: AbortSignal): PluginBackendHost {
  const request = <T>(method: string, params?: unknown, mutation = false): Promise<T> => new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    requirePluginJson(params ?? null)
    if (hostRequests.size >= 32) throw new Error('Too many pending host requests.')
    const id = ++hostSequence
    const clear = () => { clearTimeout(timer); hostRequests.delete(id); signal?.removeEventListener('abort', abort) }
    const fail = (error: Error) => { clear(); reject(error) }
    const abort = () => fail(signal!.reason)
    const timer = setTimeout(() => fail(new Error('Plugin host request timed out.')), mutation ? 30_000 : 10_000)
    timer.unref()
    hostRequests.set(id, { resolve: value => { clear(); resolve(value as T) }, reject: fail })
    if (!mutation) signal?.addEventListener('abort', abort, { once: true })
    try { port.postMessage({ hostRequest: id, method, params }) } catch (error) { fail(error as Error) }
  })
  return { getViews: () => request('getViews'), getSettings: () => request('getSettings'),
    openView: options => request('openView', options, true), moveView: options => request('moveView', options, true) }
}

async function start(): Promise<void> {
  backend = load(process.argv[2]) as PluginBackend
  if (!backend || typeof backend !== 'object') throw new Error('Plugin backend must export an object.')
  for (const key of ['activate', 'call', 'deactivate'] as const) {
    if (backend[key] !== undefined && typeof backend[key] !== 'function') throw new Error(`Invalid backend ${key} function.`)
  }
  if (backend.tools !== undefined && (!backend.tools || typeof backend.tools !== 'object' || Array.isArray(backend.tools)
    || Object.values(backend.tools).some(handler => typeof handler !== 'function'))) throw new Error('Invalid backend tools.')
  const activation = Promise.resolve().then(() => backend.activate?.({ ...JSON.parse(process.argv[3]), host: host() }))
  port.on('message', ({ data }: { data: Request }) => {
    if (typeof data.hostResponse === 'number') {
      const pending = hostRequests.get(data.hostResponse)
      if (pending) {
        if (data.error) pending.reject(new Error(data.error))
        else pending.resolve(data.result)
      }
      return
    }
    if (typeof data.cancel === 'number') {
      running.get(data.cancel)?.controller.abort(new Error(data.reason ?? 'cancelled'))
      return
    }
    if (data.stop) {
      if (stopping) return
      stopping = true
      for (const item of running.values()) item.controller.abort(new Error('Plugin backend stopped.'))
      // Closing resources can be what settles an accepted call. Start cleanup
      // after activation, concurrently with those calls, then retain their receipts.
      const cleanup = activation.catch(() => undefined).then(async () => {
        try { await backend.deactivate?.() } catch (error) {
          port.postMessage({ stopError: String(error instanceof Error ? error.message : error).slice(0, 4000) })
        }
      })
      void Promise.allSettled([cleanup, ...[...running.values()].map(item => item.done)]).then(() => process.exit(0))
      return
    }
    if (stopping) return
    const controller = new AbortController()
    const done = Promise.resolve().then(async () => {
      let completed = false
      try {
        const context = { ...data.context, signal: controller.signal, host: host(controller.signal) }
        const handler = data.tool && backend.tools && Object.hasOwn(backend.tools, data.method) ? backend.tools[data.method] : undefined
        if (data.tool ? !handler : !backend.call) throw new Error('Plugin backend has no requested handler.')
        controller.signal.throwIfAborted()
        const result = (data.tool
          ? await handler!(data.params, context as PluginToolContext)
          : await backend.call!(data.method, data.params, context as PluginBackendCallContext & { signal: AbortSignal })) ?? null
        completed = true
        const validated = data.tool ? validatePluginToolResult(result) : (requirePluginJson(result), result)
        port.postMessage({ id: data.id, result: validated })
      } catch (error) {
        port.postMessage({ id: data.id, error: String(error instanceof Error ? error.message : error).slice(0, 4000), ...(data.tool && completed ? { resultError: true } : {}) })
      } finally { running.delete(data.id) }
    }).catch(() => process.exit(1))
    running.set(data.id, { controller, done })
  })
  await activation
  port.postMessage({ ready: true })
}

void start().catch(error => {
  port.postMessage({ ready: false, error: String(error instanceof Error ? error.message : error).slice(0, 4000) })
  process.exitCode = 1
})

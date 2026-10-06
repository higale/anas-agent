import { createRequire } from 'node:module'
import { requirePluginJson } from '@shared/plugins'

const port = process.parentPort!
const load = createRequire(__filename)
interface PluginBackend {
  activate?(context: { pluginId: string; packageDirectory: string; dataDirectory: string }): unknown
  call?(method: string, params: unknown): unknown
  deactivate?(): unknown
}
let backend: PluginBackend
let tail = Promise.resolve()

async function start(): Promise<void> {
  backend = load(process.argv[2]) as PluginBackend
  if (!backend || typeof backend !== 'object') throw new Error('Plugin backend must export an object.')
  for (const key of ['activate', 'call', 'deactivate'] as const) {
    if (backend[key] !== undefined && typeof backend[key] !== 'function') throw new Error(`Invalid backend ${key} function.`)
  }
  await backend.activate?.(JSON.parse(process.argv[3]))
  port.on('message', ({ data }: { data: { id: number; method: string; params?: unknown; stop?: boolean } }) => {
    tail = tail.then(async () => {
      if (data.stop) {
        try { await backend.deactivate?.() } catch (error) {
          port.postMessage({ stopError: String(error instanceof Error ? error.message : error).slice(0, 4000) })
        } finally { process.exit(0) }
      }
      try {
        if (!backend.call) throw new Error('Plugin backend has no call handler.')
        const result = await backend.call(data.method, data.params) ?? null
        requirePluginJson(result)
        port.postMessage({ id: data.id, result })
      } catch (error) {
        port.postMessage({ id: data.id, error: String(error instanceof Error ? error.message : error).slice(0, 4000) })
      }
    }).catch(() => process.exit(1))
  })
  port.postMessage({ ready: true })
}

void start().catch(error => {
  port.postMessage({ ready: false, error: String(error instanceof Error ? error.message : error).slice(0, 4000) })
  process.exitCode = 1
})

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

const source = ts.transpileModule(readFileSync(join(__dirname, 'pluginWorker.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function worker(backend: object) {
  const port = new EventEmitter()
  const sent: Array<Record<string, unknown>> = []
  const exit = vi.fn()
  Object.assign(port, { postMessage: (message: Record<string, unknown>) => sent.push(message) })
  runInNewContext(source, {
    exports: {}, __filename: '/worker.js', AbortController, setTimeout, clearTimeout,
    process: { parentPort: port, argv: ['node', 'worker', 'backend', '{}'], exit },
    require: (id: string) => {
      if (id === 'node:module') return { createRequire: () => () => backend }
      if (id === '@shared/plugins') return { requirePluginJson: () => {} }
      if (id === './pluginToolResult') return { validatePluginToolResult: (value: unknown) => value }
      throw new Error(`Unexpected import: ${id}`)
    }
  })
  return { sent, exit, send: (data: object) => port.emit('message', { data }) }
}

it('single-call cancellation leaves shared resources alive and retains the receipt', async () => {
  const receipt = deferred()
  let signal!: AbortSignal
  const deactivate = vi.fn()
  const child = worker({ deactivate, tools: { input: async (_: unknown, context: { signal: AbortSignal }) => {
    signal = context.signal
    await receipt.promise
    return { accepted: true }
  } } })
  await tick()
  child.send({ id: 1, method: 'input', tool: true, context: {} })
  await tick()
  child.send({ cancel: 1, reason: 'timeout' })
  await tick()
  expect(signal.aborted).toBe(true)
  expect(deactivate).not.toHaveBeenCalled()
  expect(child.exit).not.toHaveBeenCalled()
  receipt.resolve()
  await tick()
  expect(child.sent).toContainEqual({ id: 1, result: { accepted: true } })
  child.send({ stop: true })
  await tick()
  expect(child.exit).toHaveBeenCalledWith(0)
})

it('starts explicit cleanup before an accepted call settles and waits for both', async () => {
  const resource = deferred(), cleanup = deferred()
  const deactivate = vi.fn(async () => { resource.resolve(); await cleanup.promise })
  const child = worker({ deactivate, tools: { input: async () => {
    await resource.promise
    throw new Error('RDP_SESSION_CLOSED')
  } } })
  await tick()
  child.send({ id: 1, method: 'input', tool: true, context: {} })
  await tick()
  child.send({ stop: true })
  child.send({ stop: true })
  await tick()
  expect(deactivate).toHaveBeenCalledOnce()
  expect(child.sent.some(item => item.id === 1 && String(item.error).includes('RDP_SESSION_CLOSED'))).toBe(true)
  expect(child.exit).not.toHaveBeenCalled()
  cleanup.resolve()
  await tick()
  expect(child.exit).toHaveBeenCalledExactlyOnceWith(0)
})

it('waits for activation before cleanup and reports cleanup errors', async () => {
  const activation = deferred()
  const deactivate = vi.fn(() => { throw new Error('cleanup failed') })
  const child = worker({ activate: () => activation.promise, deactivate })
  child.send({ stop: true })
  await tick()
  expect(deactivate).not.toHaveBeenCalled()
  activation.resolve()
  await tick()
  expect(deactivate).toHaveBeenCalledOnce()
  expect(child.sent.some(item => String(item.stopError).includes('cleanup failed'))).toBe(true)
  expect(child.exit).toHaveBeenCalledWith(0)
})

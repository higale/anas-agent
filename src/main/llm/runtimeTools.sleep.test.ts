import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeTools, type RuntimeToolOptions } from './runtimeTools'

const options: RuntimeToolOptions = {
  enabled: true, primaryFolder: process.cwd(), memory: false,
  network: false, shell: false, mcp: false, backgroundTools: false,
  toolNames: ['sleep']
}

async function sleepTool(overrides: Partial<RuntimeToolOptions> = {}) {
  return (await createRuntimeTools({ ...options, ...overrides })).find(tool => tool.name === 'sleep')!
}

afterEach(() => vi.useRealTimers())

describe('sleep tool', () => {
  it.each([1, 15, 300])('waits for %s seconds before returning the elapsed time', async (seconds) => {
    vi.useFakeTimers()
    const tool = await sleepTool()
    let completed = false
    const pending = tool.invoke({ seconds }).then(result => { completed = true; return result })
    await vi.advanceTimersByTimeAsync(seconds * 1000 - 1)
    expect(completed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(JSON.parse(await pending)).toEqual({ status: 'completed', elapsed_seconds: seconds })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([{}, { seconds: 0 }, { seconds: -1 }, { seconds: 0.5 }, { seconds: 1.5 }, { seconds: 301 }, { seconds: '10' }, { seconds: Infinity }])(
    'rejects an invalid duration instead of changing it: %j', async (input) => {
      vi.useFakeTimers()
      const tool = await sleepTool()
      await expect(tool.invoke(input)).rejects.toThrow()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['run', 'invocation'] as const)('cancels on the %s signal and clears the timer', async (source) => {
    vi.useFakeTimers()
    const run = new AbortController(), invocation = new AbortController()
    const tool = await sleepTool({ signal: run.signal })
    const pending = tool.invoke({ seconds: 300 }, { signal: invocation.signal })
    const rejected = expect(pending).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(1000)
    const controller = source === 'run' ? run : invocation
    controller.abort(new Error('Stopped'))
    await rejected
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not schedule a wait when already cancelled', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    controller.abort(new Error('Stopped'))
    const tool = await sleepTool({ signal: controller.signal })
    await expect(tool.invoke({ seconds: 10 })).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('uses its own selection with background tools %s', async (backgroundTools) => {
    const selected = await createRuntimeTools({ ...options, backgroundTools })
    expect(selected.map(tool => tool.name)).toContain('sleep')
    const disabled = await createRuntimeTools({ ...options, backgroundTools, toolNames: [] })
    expect(disabled.map(tool => tool.name)).not.toContain('sleep')
    expect(await createRuntimeTools({ ...options, enabled: false })).toEqual([])
  })
})

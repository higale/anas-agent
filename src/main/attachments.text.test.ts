import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ path: '', bytes: 0, maxChars: 32, overflow: 'truncate' }))
vi.mock('electron', () => ({ app: {}, nativeImage: {}, protocol: {} }))
vi.mock('./config/appConfig', () => ({ getAppConfigSnapshot: async () => ({ settings: {
  attachmentTextMaxChars: state.maxChars, attachmentTextOverflow: state.overflow
} }) }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const result = await fs.readFile(...args)
      if (String(args[0]) === state.path) state.bytes += Buffer.byteLength(result)
      return result
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args)
      if (String(args[0]) === state.path) {
        const read = file.read.bind(file)
        vi.spyOn(file, 'read').mockImplementation(async (...input) => {
          const result = await Reflect.apply(read, file, input)
          state.bytes += result.bytesRead
          return result
        })
      }
      return file
    }
  }
})
import { readSelectedAttachments } from './attachments'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'anas-text-budget-'))
  state.path = join(root, 'text.txt'); state.bytes = 0; state.maxChars = 32; state.overflow = 'truncate'
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

it.each(['truncate', 'error'])('bounds input before handling a large text attachment (%s)', async overflow => {
  state.overflow = overflow
  await writeFile(state.path, 'x'.repeat(8 * 1024 * 1024))
  const [result] = await readSelectedAttachments([state.path])
  if (overflow === 'truncate') expect(result).toMatchObject({ text: 'x'.repeat(32), truncated: true })
  else {
    expect(result.text).toBeUndefined()
    expect(result.skippedReason).toContain('32 characters')
  }
  expect(state.bytes).toBeGreaterThan(0)
  expect(state.bytes).toBeLessThanOrEqual(4 * (state.maxChars + 1))
})

it.each(['', 'x'.repeat(32), '\ufeff中文😀\r\n', 'a'.repeat(65_534) + '中😀文'])('preserves exact UTF-8 content and boundary characters (%#)', async text => {
  state.maxChars = Math.max(1, text.length)
  await writeFile(state.path, text)
  expect((await readSelectedAttachments([state.path]))[0]).toMatchObject({ text, truncated: false })
})

it('truncates multibyte input by the existing UTF-16 character limit', async () => {
  state.maxChars = 65_537
  const text = '\ufeff' + 'a'.repeat(65_534) + '中😀文'.repeat(100)
  await writeFile(state.path, text)
  expect((await readSelectedAttachments([state.path]))[0]).toMatchObject({ text: text.slice(0, state.maxChars), truncated: true })
  expect(state.bytes).toBeLessThanOrEqual(4 * (state.maxChars + 1))
})

it('flushes an incomplete final UTF-8 sequence as replacement text', async () => {
  await writeFile(state.path, Buffer.from([0x61, 0xe4, 0xb8]))
  expect((await readSelectedAttachments([state.path]))[0]).toMatchObject({ text: 'a\ufffd', truncated: false })
})

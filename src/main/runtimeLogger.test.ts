import log from 'electron-log/main'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { configureRuntimeLogger, openRuntimeLogViewer, runtimeLog } from './runtimeLogger'

const state = vi.hoisted(() => ({ directory: '', openPath: vi.fn(async () => '') }))
vi.mock('./config/dataDir', () => ({ getLogDir: () => state.directory }))
vi.mock('electron', () => ({ shell: { openPath: state.openPath } }))
vi.mock('electron-log/main', async () => {
  const logger = (await import('electron-log/node')).default.create({ logId: 'runtime-viewer-test' })
  return { default: Object.assign(logger, { initialize() {} }) }
})

let viewer: ChildProcessWithoutNullStreams | undefined
afterEach(async () => {
  if (viewer && viewer.exitCode === null) {
    const closed = once(viewer, 'close')
    viewer.kill()
    await closed
  }
  viewer = undefined
  if (state.directory) rmSync(state.directory, { recursive: true, force: true })
})

it('does not prune old log files through a linked log root', () => {
  const root = mkdtempSync(join(tmpdir(), 'anas-log-retention-'))
  try {
    const outside = join(root, 'external')
    mkdirSync(outside)
    const sentinel = join(outside, '2001-01-01_main.log')
    writeFileSync(sentinel, 'must survive automatic retention')
    state.directory = join(root, 'log')
    symlinkSync(outside, state.directory, process.platform === 'win32' ? 'junction' : 'dir')
    configureRuntimeLogger('info', 7)
    expect(readFileSync(sentinel, 'utf8')).toBe('must survive automatic retention')
  } finally { rmSync(root, { recursive: true, force: true }); state.directory = '' }
})

it('prunes regular old logs while retaining linked child directories and current logs', () => {
  const root = mkdtempSync(join(tmpdir(), 'anas-log-retention-'))
  try {
    const outside = join(root, 'external')
    state.directory = join(root, 'log')
    mkdirSync(outside); mkdirSync(state.directory)
    const old = '2001-01-01_main.log'
    writeFileSync(join(outside, old), 'outside')
    writeFileSync(join(state.directory, old), 'expired')
    writeFileSync(join(state.directory, '2099-01-01_main.log'), 'recent')
    symlinkSync(outside, join(state.directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    configureRuntimeLogger('info', 7)
    expect(() => readFileSync(join(state.directory, old))).toThrow()
    expect(readFileSync(join(outside, old), 'utf8')).toBe('outside')
    expect(readFileSync(join(state.directory, '2099-01-01_main.log'), 'utf8')).toBe('recent')
  } finally { rmSync(root, { recursive: true, force: true }); state.directory = '' }
})

it.runIf(process.platform === 'win32')('displays UTF-8 log history and appended Chinese in Windows PowerShell', async () => {
  state.directory = mkdtempSync(join(tmpdir(), "anas 日志 [中文] ' %!测试-"))
  configureRuntimeLogger('info')
  log.transports.console.level = false
  const history = '历史日志：可靠、严谨、友善 🙂'
  const appended = '新增日志：中文路径 C:\\项目\\文件.txt'
  runtimeLog('info', 'encoding', history)
  const path = await openRuntimeLogViewer()
  expect(readFileSync(path, 'utf8')).toContain(history)
  expect(state.openPath).toHaveBeenCalledWith(join(state.directory, '_anas_tail_log.cmd'))

  // Read through the generated script with a legacy code page as the starting state.
  const script = join(state.directory, '_anas_tail_log.ps1').replaceAll("'", "''")
  viewer = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936); & '${script}'`],
  { windowsHide: true })
  let output = '', errors = ''
  viewer.stdout.setEncoding('utf8')
  viewer.stderr.setEncoding('utf8')
  viewer.stdout.on('data', chunk => { output += chunk })
  viewer.stderr.on('data', chunk => { errors += chunk })
  await expect.poll(() => output, { timeout: 5000 }).toContain(history)
  runtimeLog('info', 'encoding', appended)
  await expect.poll(() => output, { timeout: 5000 }).toContain(appended)
  expect(errors).toBe('')
}, 15_000)

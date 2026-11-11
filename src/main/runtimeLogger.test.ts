import log from 'electron-log/main'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

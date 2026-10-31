import log from 'electron-log/main'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { configureRuntimeLogger } from '../runtimeLogger'
import { annotateModelFailure } from '../../runtime/modelRecoveryDiagnostics'
import { recordModelRecovery } from './modelRecoveryDiagnostics'

const directory = vi.hoisted(() => ({ path: '' }))
vi.mock('../config/dataDir', () => ({ getLogDir: () => directory.path }))
vi.mock('electron', () => ({ shell: {} }))
vi.mock('electron-log/main', async () => {
  const logger = (await import('electron-log/node')).default.create({ logId: 'recovery-file-test' })
  // No Electron IPC bridge in this file-transport test.
  return { default: Object.assign(logger, { initialize() {} }) }
})
afterEach(() => { if (directory.path) rmSync(directory.path, { recursive: true, force: true }) })

it.each([false, true])('writes nested response evidence to ordinary logs, oversized=%s', oversized => {
  directory.path = mkdtempSync(join(tmpdir(), 'anas-recovery-log-'))
  configureRuntimeLogger('info')
  log.transports.console.level = false
  const args = 'MALFORMED_START' + (oversized ? 'x'.repeat(10000) : '{') + 'MALFORMED_END'
  const responses = [
    { kind: 'assistant', invalidCalls: [{ id: 'bad', name: 'write_file', args }] },
    { choices: [{ message: { tool_calls: [{ id: 'bad', function: { name: 'write_file', arguments: args } }] } }] },
    { content: [{ type: 'tool_use', id: 'bad', name: 'write_file', input: args }] }
  ]
  for (const response of responses) {
    const error = annotateModelFailure(new Error('Invalid tool call'), { response })
    recordModelRecovery({ event: 'scheduled', threadId: 'thread', runId: 'run', error })
  }
  const text = readdirSync(directory.path).filter(name => name.endsWith('_main.log'))
    .map(name => readFileSync(join(directory.path, name), 'utf8')).join('\n')
  expect(text.match(/MALFORMED_START/g)).toHaveLength(responses.length)
  expect(text.match(/MALFORMED_END/g)).toHaveLength(responses.length)
  expect(text.match(/write_file/g)).toHaveLength(responses.length)
  expect(text).not.toContain('[Object]')
  expect(text.length).toBeLessThan(24000)
})

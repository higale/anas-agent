import { describe, expect, it } from 'vitest'
import { builtinPanelCanInvoke } from './builtinPanelAccess'
import type { BuiltinPanel } from '@shared/panels'

const files: BuiltinPanel = { kind: 'files', projectId: 'project-a', threadId: 'thread-a' }
const subagent: BuiltinPanel = { kind: 'subagent', projectId: 'project-a', threadId: 'thread-a', runId: 'run-a', subagentId: 'child', name: 'Child' }
describe('built-in panel context boundaries', () => {
  it('binds file and Git reads to the originating conversation and project', () => {
    expect(builtinPanelCanInvoke(files, 'agent:changes:git', [{ projectId: 'project-a' }])).toBe(true)
    expect(builtinPanelCanInvoke(files, 'agent:changes:git', [{ projectId: 'project-b' }])).toBe(false)
    expect(builtinPanelCanInvoke(files, 'agent:changes:roundContents', [{ threadId: 'thread-a' }])).toBe(true)
    expect(builtinPanelCanInvoke(files, 'agent:changes:roundContents', [{ threadId: 'thread-b' }])).toBe(false)
    expect(builtinPanelCanInvoke({ kind: 'files', projectId: 'project-a' }, 'agent:changes:rounds', [{}])).toBe(false)
  })
  it('binds activity pagination and deferred details to the selected run', () => {
    for (const channel of ['agent:activities:get', 'agent:activities:loadEarlier', 'agent:activities:subagent']) {
      expect(builtinPanelCanInvoke(subagent, channel, [{ threadId: 'thread-a', runId: 'run-a' }])).toBe(true)
      expect(builtinPanelCanInvoke(subagent, channel, [{ threadId: 'thread-a', runId: 'run-b' }])).toBe(false)
      expect(builtinPanelCanInvoke(subagent, channel, [{ threadId: 'thread-b', runId: 'run-a' }])).toBe(false)
    }
  })
  it('resolves image previews in the original project only', () => {
    expect(builtinPanelCanInvoke(subagent, 'files:readAttachmentPreview', ['result.png', { projectId: 'project-a' }])).toBe(true)
    expect(builtinPanelCanInvoke(subagent, 'files:readAttachmentPreview', ['result.png', { projectId: 'project-b' }])).toBe(false)
    expect(builtinPanelCanInvoke(subagent, 'files:readAttachmentPreview', ['/absolute/result.png', { mode: 'original' }])).toBe(true)
  })
  it('never gives a presentation page general task, configuration, or plugin administration', () => {
    for (const panel of [files, subagent, { kind: 'document', documentId: 'USER_GUIDE.en.md' } as const]) {
      for (const channel of ['agent:runs:submit', 'agent:runs:cancel', 'config:get', 'config:updateSettings', 'plugins:invoke', 'projects:delete']) {
        expect(builtinPanelCanInvoke(panel, channel, [])).toBe(false)
      }
    }
    expect(builtinPanelCanInvoke(files, 'agent:panels:review', [])).toBe(true)
    expect(builtinPanelCanInvoke(subagent, 'agent:panels:review', [])).toBe(false)
  })
})

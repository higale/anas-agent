import { AgentStorage } from './agentStorage'
import { describe, expect, it, vi } from 'vitest'
import { createPatch } from 'diff'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureCodeReview, codeReviewPrompt } from './codeReview'
import { validateCodeReviewSnapshot } from '../../runtime/codeReviewReport'
import { reviewLocations } from '@shared/codeReview'
import type { AgentApplicationReadModel } from './agentApplicationTypes'
import { encodeConversationMessage, decodeConversationMessage } from '../../runtime/conversationStorage'
import { presentConversationMessage } from './conversationPresentation'

const mocks = vi.hoisted(() => ({ project: vi.fn(), git: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: mocks.project }))
vi.mock('../gitChanges', () => ({ queryGitChanges: mocks.git }))
const version = 'a'.repeat(64)
const request = { kind: 'recorded' as const, threadId: 'thread', runId: 'source-run', version, target: 'recorded' as const }
function source(overrides: Record<string, unknown> = {}) {
  return { getRun: () => ({ threadId: 'thread' }), getThread: () => ({ projectId: 'project' }),
    fileChanges: {
      queryRoundFiles: vi.fn(() => ({ runId: 'source-run', version, hasMore: false, pendingRunIds: [], issues: [],
        files: [{ path: '/project/a.ts', continuity: 'recorded' }], ...overrides })),
      readRoundContent: vi.fn(() => ({ status: 'ready', path: '/project/a.ts', before: 'const a = 1\n', after: 'const a = 2\n', beforeExists: true, afterExists: true }))
    }

  } as unknown as AgentApplicationReadModel
}
const snapshot = () => captureCodeReview(source(), request, 'project')

describe('code review scope capture', () => {
  it('freezes a bounded identified snapshot and rejects tampering after a JSON round trip', async () => {
    const value = await snapshot()
    expect(validateCodeReviewSnapshot(JSON.parse(JSON.stringify(value)))).toEqual(value)
    expect(value.files[0].after).toEqual([{ start: 1, end: 1 }])
    expect(() => validateCodeReviewSnapshot({ ...value, description: 'different' })).toThrow('identity')
    expect(codeReviewPrompt(value)).toContain('not a request to fix, edit, commit or push')
  })
  it('checks actual conversation, project and run ownership', async () => {
    await expect(captureCodeReview(source(), { ...request, threadId: 'other' }, 'project')).rejects.toThrow('belong')
    await expect(captureCodeReview(source(), request, 'other')).rejects.toThrow('belong')
  })
  it.each([{ hasMore: true }, { pendingRunIds: ['child'] }, { files: [] },
    { files: [{ unavailableReason: 'lost' }] }])('rejects a scope that cannot be reviewed intact: %o', async (value) => {
    await expect(captureCodeReview(source(value), request, 'project')).rejects.toThrow()
  })
  it('retains uncertainty instead of pretending discontinuous recorded changes are exact net changes', async () => {
    const database = source({ issues: [{ path: '/project/a.ts', reason: 'external change' }] })
    const value = await captureCodeReview(database, request, 'project')
    expect(value.limitations).toEqual(['/project/a.ts: external change'])
    expect(database.fileChanges.queryRoundFiles).toHaveBeenCalledWith(expect.objectContaining({ version }))
  })
  it('captures the displayed current-file target instead of silently reviewing the archived result', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-round-review-')))
    try {
      const path = join(root, 'example.ts')
      await writeFile(path, 'const a = 3\n')
      const database = source({ files: [{ path, continuity: 'recorded' }] })
      vi.mocked(database.fileChanges.readRoundContent).mockReturnValue({ status: 'ready', path,
        before: 'const a = 1\n', after: 'const a = 2\n', beforeExists: true, afterExists: true })
      const archived = await captureCodeReview(database, request, 'project')
      const current = await captureCodeReview(database, { ...request, target: 'current' }, 'project')
      expect(archived.files[0].patch).toContain('+const a = 2')
      expect(current.files[0].patch).toContain('+const a = 3')
      expect(current.files[0].patch).not.toContain('+const a = 2')
      expect(current.request).toMatchObject({ target: 'current' })
      await writeFile(path, 'const a = 4\n')
      expect(validateCodeReviewSnapshot(current).files[0].patch).toContain('+const a = 3')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('pins every Git page to the user-selected version and uses resolved commits', async () => {
    mocks.project.mockResolvedValue({ kind: 'workspace', sourceFolders: ['/repo'] })
    mocks.git.mockResolvedValueOnce({ files: [{ path: '/repo/a', patch: createPatch('a', 'old\n', 'new\n') }],
      baseline: 'b'.repeat(40), head: 'c'.repeat(40), sourceFolder: '/repo', hasMore: true, nextAfter: 20 })
      .mockResolvedValueOnce({ files: [], baseline: 'b'.repeat(40), head: 'c'.repeat(40), sourceFolder: '/repo', hasMore: false })
    const value = await captureCodeReview(source(), { kind: 'git', projectId: 'project', sourceFolder: '/repo', scope: 'baseline', baseline: 'main', version }, 'project')
    expect(value.description).toContain(`${'b'.repeat(40)} → ${'c'.repeat(40)}`)
    expect(mocks.git).toHaveBeenLastCalledWith(expect.objectContaining({ after: 20, version }), expect.any(AbortSignal))
  })
  it('regenerates with the saved review scope instead of recapturing current files', async () => {
    const value = await snapshot(), root = await mkdtemp(join(tmpdir(), 'anas-native-review-regenerate-'))
    const storage = AgentStorage.openNative(root), thread = storage.createThread()
    const database = storage.conversationForThread(thread.id), owner = { threadId: thread.id, runId: 'review' }
    try {
      database.runs.createRun({ ...owner, operation: 'agent', message: { id: 'review:input', value: { id: 'review:input', kind: 'user',
        content: codeReviewPrompt(value), context: { runId: owner.runId, reviewScope: value } } } })
      await database.runs.enter('input', owner)
      const scope = () => ({ ...owner, expectedRevisionId: database.runs.store.load(thread.id)!.revisionId })
      database.runs.store.acceptModel(scope(), { id: 'answer', value: { kind: 'assistant', content: 'Saved review' } }, [], { modelCalls: 1, todos: [] })
      database.runs.store.finish(scope(), 'completed')
      database.history.commit(database.history.prepare({ threadId: thread.id, messageId: 'review:input', kind: 'regenerate', runId: 'regenerated' }))
      const input = database.runs.readRunInput({ threadId: thread.id, runId: 'regenerated' })!
      expect(validateCodeReviewSnapshot(input.value.context?.reviewScope)).toEqual(value)
      expect(input.value.content).toBe(codeReviewPrompt(value))
    } finally { storage.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('projects the full review user message without substituting a display title', async () => {
    const value = await snapshot(), prompt = codeReviewPrompt(value)
    const message = decodeConversationMessage(encodeConversationMessage({ kind: 'user', content: prompt,
      context: { displayText: '代码审核', reviewScope: value } }))
    const projected = presentConversationMessage(message, 'review-input')
    expect(projected.content).toEqual([{ type: 'text', text: prompt }])
    expect(prompt).toContain(value.files[0].patch)
    expect(projected.skillInvocation).toBeUndefined()
  })
  it('validates file identity and hunk line ranges without converting uncertainty into clickable locations', async () => {
    const scope = await snapshot()
    const finding = { priority: 'P2' as const, title: 'Defect', file_id: 'file-1', side: 'after' as const,
      start_line: 1, end_line: 1, condition: 'Trigger', impact: 'Impact', evidence: 'Evidence' }
    const report = { scope_id: scope.id, summary: 'Results', findings: [finding, { ...finding, file_id: 'unknown' }, { ...finding, end_line: 2 }], limitations: [] }
    expect(reviewLocations(scope, report).map((entry) => entry.valid)).toEqual([true, false, false])
    expect(reviewLocations(scope, { ...report, scope_id: version }).every((entry) => !entry.valid)).toBe(true)
  })
})

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '../../shared/types'
import { getProject, readProjectStoreFile } from '../projectStore'
import { getProjectStoreFile } from '../config/dataDir'
import { AgentStorage } from './agentStorage'
import { ConversationRuntimeDirectory, type ConversationRuntimeLifetime } from './conversationRuntimeDirectory'
import type { NativeConversationDatabase } from './nativeConversationDatabase'
import { createAgentRunSubmissionExecutionInput, type AgentRunSubmissionExecutionInput } from './agentRunInput'

const paths = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getLocale: () => 'en' } }))
vi.mock('../config/dataDir', async original => ({ ...await original<typeof import('../config/dataDir')>(),
  getDataDir: () => paths.root,
  getProjectStoreFile: () => join(paths.root, 'db/projects/state.json'),
  getDefaultWorkspaceDir: () => join(paths.root, 'workspace') }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

interface Runtime extends ConversationRuntimeLifetime { database: NativeConversationDatabase }
class Directory extends ConversationRuntimeDirectory<NativeConversationDatabase, Runtime> {
  submit(input: AgentRunSubmissionExecutionInput) {
    return this.routeSubmission(input, async runtime => {
      const project = await getProject(input.newThread!.projectId)
      return runtime.database.runs.createThread({ projectId: project.id }, input.threadId)
    })
  }
}

it.each([DEFAULT_WORKSPACE_PROJECT_ID, 'missing-project'])('resolves project %s before creating its first conversation directory', async projectId => {
  paths.root = await mkdtemp(join(tmpdir(), 'anas-project-initialization-'))
  let storage = AgentStorage.openNative(paths.root)
  const directory = new Directory(storage, {
    create: database => ({ database, hasLiveWork: () => false, retireIfIdle: () => true,
      shutdown: async () => ({ drained: true, lingeringRunIds: [], lingeringCallIds: [] }),
      resumeAfterIncompleteShutdown() {} }),
    unresolvedThreads: () => [], startupCleanup: async () => {}
  })
  const input = createAgentRunSubmissionExecutionInput({ requestId: randomUUID(), text: 'First conversation', newThread: { projectId } })
  try {
    if (projectId === DEFAULT_WORKSPACE_PROJECT_ID) {
      expect((await directory.submit(input)).projectId).toBe(projectId)
      expect((await readProjectStoreFile(getProjectStoreFile())).projects[0].id).toBe(projectId)
      await directory.shutdown()
      storage.close()
      storage = AgentStorage.openNative(paths.root)
      expect(storage.getThread(input.threadId)?.projectId).toBe(projectId)
    } else {
      await expect(directory.submit(input)).rejects.toThrow('was not found')
      expect(existsSync(join(paths.root, 'db/projects', projectId))).toBe(false)
      expect(storage.listThreads()).toEqual([])
    }
  } finally {
    await directory.shutdown()
    storage.close()
    await rm(paths.root, { recursive: true, force: true })
  }
})

import type { AgentThread, AgentSystemContextPreviewInput } from '../../shared/agentTypes'
import type { AppConfigSnapshot, Project } from '../../shared/types'
import { newThreadDraftModelSelection, projectDraftModelSelection } from '../../shared/draftModelSelection'
import { findProviderModelConfig } from '../../shared/modelConfig'
import { getAppConfigSnapshot } from '../config/appConfig'
import { prepareProjectPreview } from '../projectStore'

export async function resolveAgentPreviewTarget(
  input: AgentSystemContextPreviewInput,
  synthetic: { id: string; title: string }
): Promise<{ config: AppConfigSnapshot; thread: AgentThread; project: Project } | undefined> {
  const persisted = await getAppConfigSnapshot()
  const project = await prepareProjectPreview(input.project, input.projectId)
  const currentSelection = projectDraftModelSelection(persisted.providers, input.currentModelSelection)
  const selection = newThreadDraftModelSelection(
    persisted,
    findProviderModelConfig(persisted.providers, currentSelection?.modelConfigId),
    currentSelection?.modelParameterPresetId ?? null,
    projectDraftModelSelection(persisted.providers, project)
  )
  if (!selection.modelConfigId) return undefined
  const now = new Date().toISOString()
  const thread: AgentThread = {
    id: synthetic.id,
    title: synthetic.title,
    projectId: project.id,
    modelConfigId: selection.modelConfigId,
    modelParameterPresetId: selection.modelParameterPresetId ?? undefined,
    pinned: false,
    accessMode: project.kind === 'workspace' ? project.accessMode ?? 'smart_approval' : 'smart_approval',
    status: 'idle',
    userTurnCount: 0,
    createdAt: now,
    updatedAt: now
  }
  return {
    config: { ...persisted, settings: input.settings },
    thread,
    project
  }
}

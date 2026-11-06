import type { BuiltinPanel } from '@shared/panels'

/** Bind data reads to the page's own context, independently of main-window selection. */
export function builtinPanelCanInvoke(panel: BuiltinPanel, channel: string, args: unknown[]): boolean {
  if (panel.kind === 'memory') return ['memory:document:read', 'memory:activity'].includes(channel)
  if (['app:readHelp', 'app:openExternalUrl', 'files:showItemInFolder', 'files:readFileIcon'].includes(channel)) return true
  if (channel === 'files:readAttachmentPreview') {
    const options = args[1] as { projectId?: string } | undefined
    return !options?.projectId || (panel.kind !== 'document' && options.projectId === panel.projectId)
  }
  if (panel.kind === 'projectMemory') {
    const scope = args[0] as { kind?: string; projectId?: string } | undefined
    return (channel === 'memory:document:read' || channel === 'memory:document:save') && scope?.kind === 'project' && scope.projectId === panel.projectId
  }
  if (panel.kind === 'document') return false
  const input = args[0] as Record<string, unknown> | undefined
  if (channel === 'agent:events:subscribe' || channel === 'agent:changes:cancelRead') return true
  // The activity handler resolves request IDs within the sending WebContents.
  if (channel === 'agent:activities:cancel') return panel.kind === 'subagent'
  if (channel === 'agent:threads:get') return !!panel.threadId && args[0] === panel.threadId
  if (['agent:activities:get', 'agent:activities:subagent', 'agent:activities:directory', 'agent:activities:detail'].includes(channel)) {
    return panel.kind === 'subagent' && input?.threadId === panel.threadId && input.runId === panel.runId
  }
  if (panel.kind !== 'files') return false
  if (channel === 'agent:panels:review') return true // The handler derives submission identity from the registered page.
  if (['agent:changes:git', 'agent:changes:gitContents', 'agent:changes:gitReferences'].includes(channel)) return input?.projectId === panel.projectId
  if (['agent:changes:rounds', 'agent:changes:roundFiles', 'agent:changes:roundContents'].includes(channel)) return !!panel.threadId && input?.threadId === panel.threadId
  return false
}

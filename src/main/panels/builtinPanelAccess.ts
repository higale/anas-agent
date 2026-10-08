import type { BuiltinPanel } from '@shared/panels'

/** Bind data reads to the page's own context, independently of main-window selection. */
export function builtinPanelCanInvoke(panel: BuiltinPanel, channel: string, args: unknown[]): boolean {
  if (['app:readHelp', 'app:openExternalUrl', 'files:showItemInFolder', 'files:readFileIcon'].includes(channel)) return true
  if (channel === 'files:readAttachmentPreview') {
    const options = args[1] as { projectId?: string } | undefined
    return !options?.projectId || (panel.kind !== 'document' && options.projectId === panel.projectId)
  }
  if (panel.kind === 'document') return false
  const input = args[0] as Record<string, unknown> | undefined
  if (channel === 'agent:events:subscribe' || channel === 'agent:changes:cancelRead') return true
  if (channel === 'agent:threads:get') return !!panel.threadId && args[0] === panel.threadId
  if (channel === 'agent:activities:get' || channel === 'agent:activities:loadEarlier' || channel === 'agent:activities:subagent') {
    return panel.kind === 'subagent' && input?.threadId === panel.threadId && input.runId === panel.runId
  }
  if (panel.kind !== 'files') return false
  if (channel === 'agent:panels:review') return true // The handler derives submission identity from the registered page.
  if (['agent:changes:git', 'agent:changes:gitContents', 'agent:changes:gitReferences'].includes(channel)) return input?.projectId === panel.projectId
  if (['agent:changes:rounds', 'agent:changes:roundFiles', 'agent:changes:roundContents'].includes(channel)) return !!panel.threadId && input?.threadId === panel.threadId
  return false
}

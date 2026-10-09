import { usePanelReady } from '../agent/PanelViewState'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { BuiltinPanel } from '@shared/panels'
import type { PanelPageContext } from '@shared/panelLifecycle'
import { HelpDocumentPanel } from '../agent/HelpDocumentPanel'
import { FileChangesPanel } from '../agent/FileChangesPanel'
import { AgentSubagentPanel } from '../agent/AgentMessageList'
import { DiffPreferences } from '../diff/DiffView'
import { MarkdownWorkspaceProjectProvider } from '../chat/MarkdownText'
import { usePanelActivity } from './usePanelActivity'
import { panelError } from './panelError'
import { notice } from '../notice'
import { localizeAgentError } from '../agent/agentErrorMessage'
import { panelApi } from './contentServices'
function SubagentContent({ content, open }: { content: Extract<BuiltinPanel, { kind: 'subagent' }>; open(panel: BuiltinPanel): void }) {
  const { t } = useTranslation()
  const { run, error, loadEarlier, loadDetails } = usePanelActivity(content.threadId, content.runId, content.subagentId)
  usePanelReady(Boolean(run), Boolean(error))
  useEffect(() => { if (error) notice.error(localizeAgentError(String(error), t)) }, [error, t])
  return run?.subagents.some(item => item.id === content.subagentId)
    ? <AgentSubagentPanel run={run} subagentId={content.subagentId} threadId={content.threadId}
        onLoadEarlierActivities={loadEarlier} onLoadSubagentDetails={loadDetails}
        onLoadEarlierError={(_id, message) => notice.error(message)}
        onOpenSubagent={(runId, subagentId) => open({ ...content, runId, subagentId,
          name: run.subagents.find(item => item.id === subagentId)?.name ?? subagentId })} />
    : <p className="ui-detail-panel-empty">{t(error ? 'agent.panel_unavailable' : 'common.loading')}</p>
}

export function BuiltinPanelContent({ state }: { state: PanelPageContext }) {
  const { t } = useTranslation()
  const api = panelApi()
  const open = (content: BuiltinPanel) => { void api.open(content).catch(reason => notice.error(panelError(reason, t))) }
  const content = state.view.content
  const project = state.project?.kind === 'workspace' ? state.project : undefined
  return <MarkdownWorkspaceProjectProvider projectId={project?.id}>
    <DiffPreferences.Provider value={{ ...state.preferences, onChange: api.updatePreferences }}>
      {content.kind === 'document' ? <HelpDocumentPanel request={content} onOpen={open} />
        : content.kind === 'files' ? <FileChangesPanel project={project} request={content}
            onReview={request => api.review(state.pageId, request, content.navigationId!)} />
          : content.kind === 'subagent' ? <SubagentContent content={content} open={open} /> : null}
    </DiffPreferences.Provider>
  </MarkdownWorkspaceProjectProvider>
}

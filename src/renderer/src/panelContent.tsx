import React, { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { panelIdentity, workspacePanelScope, type BuiltinPanel, type PanelContentState } from '@shared/panels'
import { applyLanguagePreference, initializeI18nFromResources } from './i18n'
import { installNativeContextMenuPolicy } from './nativeContextMenuPolicy'
import { HelpDocumentPanel } from './ui/agent/HelpDocumentPanel'
import { FileChangesPanel } from './ui/agent/FileChangesPanel'
import { AgentSubagentPanel } from './ui/agent/AgentMessageList'
import { PanelViewState } from './ui/agent/PanelViewState'
import { DiffPreferences } from './ui/diff/DiffView'
import { MarkdownWorkspaceProjectProvider } from './ui/chat/MarkdownText'
import { usePanelActivity } from './ui/panels/usePanelActivity'
import { installPanelEscapeHandler } from './ui/panels/panelKeyboard'
import { isPanelClosed, panelError } from './ui/panels/panelError'
import { GlobalTooltip } from './ui/GlobalTooltip'
import { NoticeHost, notice } from './ui/notice'
import { localizeAgentError } from './ui/agent/agentErrorMessage'
import './ui/panels/contentServices'
import 'sonner/dist/styles.css'
import './styles.css'

const api = window.panelContent!

function SubagentContent({ content, open }: { content: Extract<BuiltinPanel, { kind: 'subagent' }>; open(panel: BuiltinPanel): void }) {
  const { t } = useTranslation()
  const { run, error, loadEarlier, loadDetails } = usePanelActivity(content.threadId, content.runId, content.subagentId)
  useEffect(() => { if (error) notice.error(localizeAgentError(String(error), t)) }, [error, t])
  return run?.subagents.some(item => item.id === content.subagentId)
    ? <AgentSubagentPanel run={run} subagentId={content.subagentId} threadId={content.threadId}
        onLoadEarlierActivities={loadEarlier} onLoadSubagentDetails={loadDetails}
        onLoadEarlierError={(_id, message) => notice.error(message)}
        onOpenSubagent={(runId, subagentId) => open({ ...content, runId, subagentId,
          name: run.subagents.find(item => item.id === subagentId)?.name ?? subagentId })} />
    : <p className="ui-detail-panel-empty">{t(error ? 'agent.panel_unavailable' : 'common.loading')}</p>
}

function PanelContent({ initial }: { initial: PanelContentState }) {
  const [state, setState] = useState(initial)
  const { t } = useTranslation()
  useEffect(() => installPanelEscapeHandler(() => {
    void api.escape().catch(reason => notice.error(panelError(reason, t)))
  }), [t])
  useEffect(() => {
    let revision = 0
    let active = true
    const refresh = () => {
      const own = ++revision
      void api.getState().then(value => {
        if (!active || own !== revision) return
        setState(previous => ({ ...value, view: { ...value.view,
          content: JSON.stringify(previous.view.content) === JSON.stringify(value.view.content) ? previous.view.content : value.view.content } }))
      }).catch(reason => { if (active && own === revision) notice.error(panelError(reason, t)) })
    }
    const stop = api.onChanged(refresh)
    refresh()
    return () => { active = false; stop() }
  }, [t])
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme
    document.documentElement.style.setProperty('--font-size-base', `${state.fontSize}px`)
    void applyLanguagePreference(state.language)
  }, [state.theme, state.fontSize, state.language])
  const open = useCallback((content: BuiltinPanel) => {
    void api.open(content).catch(reason => { if (!isPanelClosed(reason)) notice.error(panelError(reason, t)) })
  }, [t])
  const content = state.view.content
  const contextKey = content.kind === 'files' ? JSON.stringify([content.projectId, workspacePanelScope(content.threadId, content.projectId)]) : panelIdentity(content)
  const project = state.project?.kind === 'workspace' ? state.project : undefined
  return <div className="panel-content-root">
    <MarkdownWorkspaceProjectProvider projectId={project?.id}>
      <DiffPreferences.Provider value={{ ...state.preferences, onChange: api.updatePreferences }}>
        <PanelViewState key={contextKey}>
          {content.kind === 'document' ? <HelpDocumentPanel request={content} onOpen={open} />
            : content.kind === 'files' ? <FileChangesPanel project={project} request={content}
                onReview={request => api.review(request, content.navigationId!)} />
              : content.kind === 'subagent' ? <SubagentContent content={content} open={open} /> : null}
        </PanelViewState>
      </DiffPreferences.Provider>
    </MarkdownWorkspaceProjectProvider>
    <GlobalTooltip />
    <NoticeHost theme={state.theme} />
  </div>
}

document.documentElement.dataset.platform = navigator.userAgent.includes('Macintosh') ? 'darwin' : navigator.userAgent.includes('Windows') ? 'win32' : 'linux'
installNativeContextMenuPolicy()
void Promise.all([api.getState(), api.getLanguageResources()]).then(async ([state, resources]) => {
  await initializeI18nFromResources(resources, state.language)
  createRoot(document.getElementById('root')!).render(<React.StrictMode><PanelContent initial={state} /></React.StrictMode>)
}).catch(() => { document.getElementById('root')!.textContent = 'Panel could not load. / 面板加载失败。' })

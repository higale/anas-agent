import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import type { PanelWindowApi, PanelWindowShellState } from '@shared/panels'
import { applyLanguagePreference, initializeI18nFromResources } from './i18n'
import { PanelPageHost } from './ui/panels/PanelPageHost'
import { panelError } from './ui/panels/panelError'
import { PanelWindowTitlebar } from './ui/panels/PanelWindowTitlebar'
import { GlobalTooltip } from './ui/GlobalTooltip'
import { NoticeHost, notice } from './ui/notice'
import 'sonner/dist/styles.css'
import './styles.css'

declare global { interface Window { panelWindow: PanelWindowApi } }

function PanelWindow({ initial }: { initial: PanelWindowShellState }) {
  const [state, setState] = useState(initial)
  const { t } = useTranslation()
  useEffect(() => window.panelWindow.onCloseFailed(() => notice.error(t('panels.operation_failed'))), [t])
  useEffect(() => {
    let changed = false
    const stop = window.panelWindow.onChanged(value => { changed = true; setState(value) })
    void window.panelWindow.getState().then(value => { if (!changed) setState(value) })
      .catch(reason => { if (!changed) notice.error(panelError(reason, t)) })
    return () => { changed = true; stop() }
  }, [t])
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme
    document.documentElement.style.setProperty('--font-size-base', `${state.fontSize}px`)
    void applyLanguagePreference(state.language)
  }, [state.theme, state.fontSize, state.language])
  return <div className="panel-window-shell" data-fullscreen={state.fullScreen}>
    <PanelWindowTitlebar view={state.view} fullScreen={state.fullScreen} />
    <div className="panel-window-slot" aria-busy={!!state.view.loading}>
      <PanelPageHost activeId={state.view.viewId} />
      {state.view.loading && <p className="ui-detail-panel-empty" role="status">{t('common.loading')}</p>}
    </div>
    <NoticeHost theme={state.theme} />
    <GlobalTooltip />
  </div>
}

document.documentElement.dataset.platform = navigator.userAgent.includes('Macintosh')
  ? 'darwin' : navigator.userAgent.includes('Windows') ? 'win32' : 'linux'

void Promise.all([window.panelWindow.getState(), window.panelWindow.getLanguageResources()]).then(async ([state, resources]) => {
  await initializeI18nFromResources(resources, state.language)
  createRoot(document.getElementById('root')!).render(<React.StrictMode><PanelWindow initial={state} /></React.StrictMode>)
}).catch(() => { document.getElementById('root')!.textContent = 'Panel could not load. / 面板加载失败。' })

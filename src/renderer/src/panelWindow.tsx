import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import type { PanelWindowApi, PanelWindowState } from '@shared/panels'
import { applyLanguagePreference, initializeI18nFromResources } from './i18n'
import { NoFocusButton } from './ui/NoFocusButton'
import { SquareArrowInDownLeft } from './ui/SquareArrowInDownLeft'
import { observePanelLayout, panelBounds } from './ui/panels/panelLayout'
import { panelError } from './ui/panels/panelError'
import { PanelToolbar } from './ui/panels/PanelToolbar'
import { GlobalTooltip } from './ui/GlobalTooltip'
import { NoticeHost, notice } from './ui/notice'
import 'sonner/dist/styles.css'
import './styles.css'

declare global { interface Window { panelWindow: PanelWindowApi } }

function PanelWindow({ initial }: { initial: PanelWindowState }) {
  const [state, setState] = useState(initial)
  const [moving, setMoving] = useState(false)
  const { t } = useTranslation()
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
  useEffect(() => {
    let previous = ''
    return observePanelLayout(() => {
      const bounds = panelBounds(document.querySelector('.panel-window-slot'))
      const next = JSON.stringify(bounds)
      if (next === previous) return
      previous = next
      void window.panelWindow.setLayout(bounds).catch(reason => notice.error(panelError(reason, t)))
    })
  }, [t])
  const move = async () => {
    setMoving(true)
    try { await window.panelWindow.moveToSidebar() }
    catch (reason) { notice.error(panelError(reason, t)) }
    finally { setMoving(false) }
  }
  return <div className="panel-window-shell">
    <div className="panel-window-titlebar">
      <strong className="ui-truncate">{state.view.name}</strong>
      <PanelToolbar view={state.view} onAction={id => {
        void window.panelWindow.invokeToolbarAction(id).catch(reason => notice.error(panelError(reason, t)))
      }} />
      {state.view.locations.includes('sidebar') && <NoFocusButton type="button" className="ui-tool-button ui-tool-button-small"
        aria-label={t('panels.move_sidebar')} data-tooltip={t('panels.move_sidebar')}
        disabled={moving || !!state.view.pendingLocation} onClick={() => void move()}>
        <SquareArrowInDownLeft size={16} aria-hidden="true" />
      </NoFocusButton>}
    </div>
    <div className="panel-window-slot" aria-busy={!!state.view.loading}>
      {state.view.loading && <p className="ui-detail-panel-empty" role="status">{t('common.loading')}</p>}
    </div>
    <NoticeHost theme={state.theme} />
    <GlobalTooltip native={window.panelWindow} />
  </div>
}

document.documentElement.dataset.platform = navigator.userAgent.includes('Macintosh')
  ? 'darwin' : navigator.userAgent.includes('Windows') ? 'win32' : 'linux'

void Promise.all([window.panelWindow.getState(), window.panelWindow.getLanguageResources()]).then(async ([state, resources]) => {
  await initializeI18nFromResources(resources, state.language)
  createRoot(document.getElementById('root')!).render(<React.StrictMode><PanelWindow initial={state} /></React.StrictMode>)
}).catch(() => { document.getElementById('root')!.textContent = 'Panel could not load. / 面板加载失败。' })

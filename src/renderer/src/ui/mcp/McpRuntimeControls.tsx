import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorDetail } from '@shared/recovery'
import type { McpToolStatus } from '@shared/types'
import { CapabilityGroupActions } from '../CapabilityGroupActions'
import { notice } from '../notice'
import { CheckboxField } from '../CheckboxField'

export function McpRuntimeControls({ id, enabled, status, onFlushDraft }: {
  id: string
  enabled: boolean
  status?: McpToolStatus
  onFlushDraft(): Promise<string>
}) {
  const { t } = useTranslation()
  const runtime = status?.servers.find(server => server.id === id)
  const catalog = status?.loaded.find(server => server.id === id)
  const [pendingChoices, setPendingChoices] = useState<Record<string, boolean>>()
  const choicesPending = useRef(false)
  const [pendingAction, setPendingAction] = useState(false)
  const actionPending = useRef(false)
  const choices = pendingChoices ?? runtime?.toolChoices ?? {}
  const names = catalog?.toolNames ?? []
  const starting = runtime?.state === 'starting' || runtime?.state === 'recovering'
  const running = runtime?.state === 'ready'
  async function setRunning(value: boolean) {
    if (actionPending.current) return
    actionPending.current = true
    setPendingAction(true)
    try {
      const savedId = await onFlushDraft()
      await window.gale.mcp.setRunning(savedId, value)
    } catch (error) { notice.error(t('settings.failed_start_mcp'), { description: errorDetail(error) }) }
    finally { actionPending.current = false; setPendingAction(false) }
  }
  async function setTools(names: string[], enabled: boolean) {
    if (choicesPending.current) return
    choicesPending.current = true
    setPendingChoices({ ...choices, ...Object.fromEntries(names.map(name => [name, enabled])) })
    try { await window.gale.mcp.setToolsEnabled(id, names, enabled) }
    catch (error) { notice.error(t('settings.failed_save_mcp_tools'), { description: errorDetail(error) }) }
    finally { choicesPending.current = false; setPendingChoices(undefined) }
  }
  return <>
    <div className="ui-row">
      <button type="button" className="ui-button" disabled={running || starting}
        aria-busy={pendingAction || undefined} onClick={() => void setRunning(true)}>{t('settings.mcp_start')}</button>
      <button type="button" className="ui-button" disabled={!runtime || ['idle', 'stopped'].includes(runtime.state)}
        onClick={() => void window.gale.mcp.setRunning(id, false).catch(error => notice.error(t('settings.failed_stop_mcp'), { description: errorDetail(error) }))}>{t('settings.mcp_stop')}</button>
      <span className="ui-muted">{t(starting ? 'settings.mcp_starting' : running ? 'settings.running' : 'settings.mcp_stopped')}</span>
    </div>
    {runtime?.lastError && <p className="ui-status-danger">{runtime.lastError}</p>}
    <div className="ui-field-stack">
      <div className="ui-row">
        <strong>{t('settings.tools_page')}</strong>
        {catalog && <span className="ui-muted">{names.filter(name => choices[name] !== false).length}/{names.length}</span>}
        {names.length > 0 && <CapabilityGroupActions allSelected={names.every(name => choices[name] !== false)}
          busy={Boolean(pendingChoices)} onChange={enabled => void setTools(names, enabled)} />}
      </div>
      {names.length > 0 ? <div className="ui-capability-list ui-grid-auto">
        {names.map(name => <CheckboxField key={name}
          label={<code className="ui-tool-name">{name.replace(`mcp__${id}__`, '')}</code>}
          checked={choices[name] !== false} aria-disabled={Boolean(pendingChoices) || undefined} aria-busy={Boolean(pendingChoices) || undefined}
          inactiveReason={!enabled ? t('capabilities.globally_disabled') : undefined}
          tooltip={status?.tools.find(tool => tool.name === name)?.description}
          onChange={value => void setTools([name], value)} />)}
      </div> : <div className="ui-muted">{t(catalog ? 'settings.mcp_empty_catalog' : 'settings.mcp_no_catalog')}</div>}
    </div>
  </>
}

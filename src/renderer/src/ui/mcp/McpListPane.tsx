import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppConfigSnapshot, McpToolStatus } from '@shared/types'
import { SettingsSelectionActions } from '../settings/SettingsListActions'
import { SettingsAvailabilityBadge } from '../settings/SettingsAvailabilityBadge'
import { mcpErrorStatus, mcpLoadedStatus, mcpServerRuntimeStatus } from './mcpDraft'

interface McpListPaneProps {
  config: AppConfigSnapshot | undefined
  disabled?: boolean
  editingIndex?: number
  listRef: RefObject<HTMLDivElement | null>
  reloadingFailed: boolean
  runtimeEnabled: boolean
  status: McpToolStatus | undefined
  onDeleteServer: () => void | Promise<void>
  onEditServer: (index: number) => void | Promise<void>
  onMoveServer: (direction: -1 | 1) => void | Promise<void>
  onReloadFailedServers: () => void | Promise<void>
}

export function McpListPane({
  config,
  disabled = false,
  editingIndex,
  listRef,
  reloadingFailed,
  runtimeEnabled,
  status,
  onDeleteServer,
  onEditServer,
  onMoveServer,
  onReloadFailedServers
}: McpListPaneProps) {
  const { t } = useTranslation()
  const servers = config?.mcpServers ?? []
  const selectedPosition = servers.findIndex(server => server.index === editingIndex)
  const selectedServer = servers[selectedPosition]
  const selectedName = selectedServer ? selectedServer.name || selectedServer.id || t('settings.mcp_server_fallback_name', { index: selectedServer.index }) : undefined

  return (
    <div className="ui-list-pane">
      <SettingsSelectionActions
        refreshLabel={t('settings.mcp_reload_failed_servers')}
        refreshTooltip={t('settings.mcp_reload_failed_servers_hint')}
        refreshDisabled={!runtimeEnabled || reloadingFailed}
        moveUpLabel={t('common.move_up')} moveDownLabel={t('common.move_down')}
        deleteLabel={t('settings.delete_mcp_server')} targetName={selectedName} disabled={disabled}
        onRefresh={() => void onReloadFailedServers()}
        onMoveUp={selectedPosition > 0 ? () => void onMoveServer(-1) : undefined}
        onMoveDown={selectedPosition >= 0 && selectedPosition < servers.length - 1 ? () => void onMoveServer(1) : undefined}
        onDelete={selectedServer ? () => void onDeleteServer() : undefined}
      />
      <div className="ui-scroll-list ui-list" ref={listRef}>
        {config && config.mcpServers.length === 0 && <div className="ui-empty-state ui-empty-state-compact">{t('settings.no_mcp_servers_configured')}</div>}
        {config?.mcpServers.map((server) => {
          const runtimeStatus = runtimeEnabled && server.enabled ? mcpServerRuntimeStatus(status, server) : undefined
          const loaded = runtimeEnabled && server.enabled ? mcpLoadedStatus(status, server) : undefined
          const errorText = runtimeEnabled && server.enabled ? mcpErrorStatus(status, server) : undefined
          const recovering = runtimeStatus?.state === 'recovering'
          const loading = runtimeEnabled && server.enabled && !loaded && !errorText && (!runtimeStatus || runtimeStatus.state === 'idle' || runtimeStatus.state === 'starting')
          const detailText = loaded
            ? t('settings.tools_count', { count: loaded.toolCount })
            : errorText
              ? t('settings.load_failed')
              : recovering
                ? t('settings.mcp_state_recovering')
                : loading
                  ? t('settings.waiting_for_tools')
                : ''
          return (
            <button
              className={server.index === editingIndex ? 'ui-list-item-split ui-list-item ui-list-item-active active' : 'ui-list-item-split ui-list-item'}
              key={`${server.index}-${server.name}`}
              type="button"
              aria-pressed={server.index === editingIndex}
              onClick={() => void onEditServer(server.index)}
            >
              <span>
                <strong>{server.name || server.id || t('settings.mcp_server_fallback_name', { index: server.index })}</strong>
                <small className="ui-list-item-meta">
                  {server.type} - {server.id || '-'}{detailText ? ` · ${detailText}` : ''}
                </small>
              </span>
              {!server.enabled || errorText ? (
                <SettingsAvailabilityBadge disabled={!server.enabled} error={Boolean(errorText)} />
              ) : loaded ? (
                <em className="ui-list-item-badge ui-badge-success">{t('settings.running')}</em>
              ) : recovering ? (
                <em className="ui-list-item-badge ui-badge-warning">{t('settings.mcp_state_recovering')}</em>
              ) : loading ? (
                <em className="ui-list-item-badge ui-badge-warning">{t('settings.pending')}</em>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

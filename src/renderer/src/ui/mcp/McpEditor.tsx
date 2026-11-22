import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppConfigSnapshot, McpServerType, McpToolStatus } from '@shared/types'
import { CheckboxButton } from '../CheckboxButton'
import { CommitNumberInput } from '../CommitNumberInput'
import { CommitTextInput, CommitTextarea } from '../CommitTextField'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { SETTINGS_MCP_TIMEOUT_MIN_MS, SETTINGS_MILLISECONDS_STEP, UI_TEXTAREA_ROWS_COMPACT } from '../uiConstants'
import { McpRuntimeControls } from './McpRuntimeControls'
import { mcpDraftHasTools, type McpDraft } from './mcpDraft'

type SelectedMcpServer = AppConfigSnapshot['mcpServers'][number]

interface McpEditorProps {
  disabled?: boolean
  mcpDraft: McpDraft
  onFlushDraft(): Promise<string>
  selectedServer?: SelectedMcpServer
  status: McpToolStatus | undefined
  onAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
  onUpdateDraft: (update: Partial<McpDraft>) => void
}

export function McpEditor({
  disabled = false,
  mcpDraft,
  onFlushDraft,
  selectedServer,
  status,
  onAutosizeInput,
  onUpdateDraft
}: McpEditorProps) {
  const { t } = useTranslation()
  const timeoutId = useId()
  const [apiKeyFocused, setApiKeyFocused] = useState(false)
  const enableBlocked = !mcpDraft.enabled && !mcpDraftHasTools(mcpDraft, status)
  const transportOptions = [
    { value: 'stdio', label: 'stdio' },
    { value: 'http', label: 'HTTP' },
    { value: 'sse', label: 'SSE' }
  ]

  return (
    <div className="ui-editor">
      <div className="ui-toolbar">
        <CheckboxButton
          checked={mcpDraft.enabled}
          disabled={disabled || enableBlocked}
          tooltip={enableBlocked ? t('settings.mcp_tools_required_enable') : undefined}
          label={t('settings.enabled')}
          onChange={(enabled) => onUpdateDraft({ enabled })}
        />
      </div>
      <div className="ui-grid-2">
        <label className="ui-field-stack">
          <span>{t('settings.name')}</span>
          <CommitTextInput value={mcpDraft.name} onCommit={(name) => onUpdateDraft({ name })} disabled={disabled} />
        </label>
        <div className="ui-field-stack">
          <span>{t('settings.transport')}</span>
          <SearchableOptionPicker
            ariaLabel={t('settings.transport')}
            disabled={disabled}
            emptyLabel={t('settings.no_options')}
            options={transportOptions}
            searchable={false}
            value={mcpDraft.type}
            onChange={(type) => onUpdateDraft({ type: type as McpServerType })}
          />
        </div>
      </div>
      <div className="ui-grid-2">
        <label className="ui-field-stack">
          <span>{t('settings.mcp_server_id')}</span>
          <CommitTextInput
            value={mcpDraft.id}
            onCommit={(id) => onUpdateDraft({ id })}
            disabled={disabled}
          />
        </label>
        <div className="ui-field-stack">
          <label className="ui-field-label" htmlFor={timeoutId}>{t('settings.timeout_ms')}</label>
          <CommitNumberInput id={timeoutId} min={SETTINGS_MCP_TIMEOUT_MIN_MS} step={SETTINGS_MILLISECONDS_STEP} value={String(mcpDraft.timeoutMs)} onCommit={(timeoutMs) => onUpdateDraft({ timeoutMs: Number(timeoutMs) })} disabled={disabled} />
        </div>
      </div>

      {mcpDraft.type === 'stdio' ? (
        <>
          <label className="ui-field-stack">
            <span>{t('settings.command')}</span>
            <CommitTextInput value={mcpDraft.command} onCommit={(command) => onUpdateDraft({ command })} placeholder="npx" disabled={disabled} />
          </label>
          <label className="ui-field-stack">
            <span>{t('settings.arguments')}</span>
            <CommitTextarea
              className="ui-autosize-textarea ui-code-textarea"
              data-max-height="none"
              value={mcpDraft.argsText}
              onInput={onAutosizeInput}
              onCommit={(argsText) => onUpdateDraft({ argsText })}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\user'}
              rows={UI_TEXTAREA_ROWS_COMPACT}
              disabled={disabled}
            />
          </label>
          <label className="ui-field-stack">
            <span>{t('settings.working_directory')}</span>
            <CommitTextInput
              value={mcpDraft.workingDir}
              onCommit={(workingDir) => onUpdateDraft({ workingDir })}
              placeholder={t('settings.mcp_working_directory_placeholder')}
              disabled={disabled}
            />
          </label>
          <label className="ui-field-stack">
            <span>{t('settings.environment')}</span>
            <CommitTextarea
              className="ui-autosize-textarea ui-code-textarea"
              data-max-height="none"
              value={mcpDraft.envText}
              onInput={onAutosizeInput}
              onCommit={(envText) => onUpdateDraft({ envText })}
              placeholder="KEY=value"
              rows={UI_TEXTAREA_ROWS_COMPACT}
              disabled={disabled}
            />
          </label>
        </>
      ) : (
        <>
          <label className="ui-field-stack">
            <span>{t('settings.url')}</span>
            <CommitTextInput value={mcpDraft.url} onCommit={(url) => onUpdateDraft({ url })} placeholder={mcpDraft.type === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp'} disabled={disabled} />
          </label>
          <label className="ui-field-stack">
            <span>{t('settings.api_key')}</span>
            <CommitTextInput
              value={mcpDraft.apiKey}
              onBlur={() => setApiKeyFocused(false)}
              onCommit={(apiKey) => onUpdateDraft({ apiKey })}
              onFocus={() => setApiKeyFocused(true)}
              placeholder={t('common.optional')}
              type={apiKeyFocused ? 'text' : 'password'}
              disabled={disabled}
            />
          </label>
        </>
      )}

      {selectedServer && <McpRuntimeControls key={selectedServer.id} id={selectedServer.id}
        enabled={mcpDraft.enabled} status={status} onFlushDraft={onFlushDraft} />}
    </div>
  )
}

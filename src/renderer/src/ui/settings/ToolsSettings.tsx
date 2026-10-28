import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  builtinToolCatalog,
  toolGroupOrder,
  frameworkToolCatalog,
  orderedToolCatalog,
  runtimeToolSelectionId
} from '@shared/toolRegistry'
import type { McpServerConfigDetail, McpToolStatus, RuntimeToolDefinition, RuntimeToolStatus } from '@shared/types'
import { ContentPreviewDialog } from './ContentPreviewDialog'
import { CustomToolsGroup } from './CustomToolsGroup'
import type { AppConfigSnapshot } from '@shared/types'
import type { ToolPackage } from '@shared/toolPackages'
import { pluginDisplayText, type PluginSummary } from '@shared/plugins'
import { pluginToolName } from '@shared/pluginTools'
import { SegmentedControl } from '../SegmentedControl'
import type { AgentAccessMode } from '@shared/agentTypes'

interface ToolsSettingsProps {
  actionsTarget?: HTMLElement | null
  plugins: PluginSummary[]
  pluginError?: string
  customTools: ToolPackage[]
  onConfigChange(config: AppConfigSnapshot): void
  mcpServers: McpServerConfigDetail[]
  mcpStatus: McpToolStatus | undefined
  runtimeToolStatus: RuntimeToolStatus | undefined
}

interface ToolDisplayGroup {
  id: string
  name: string
  tools: RuntimeToolDefinition[]
  disabled?: boolean
  error?: string
}

export function mcpToolDisplayGroups(
  status: McpToolStatus | undefined,
  configuredServers: McpServerConfigDetail[]
): ToolDisplayGroup[] {
  const definitions = new Map<string, RuntimeToolDefinition[]>()
  for (const tool of status?.tools ?? []) {
    definitions.set(tool.name, [...(definitions.get(tool.name) ?? []), tool])
  }
  const refs = configuredServers.length > 0
    ? configuredServers
    : (status?.servers ?? [])
  const groups: ToolDisplayGroup[] = refs.map((server) => {
    const loaded = status?.loaded.find((item) =>
      item.id === server.id && item.index === server.index
    )
    const tools = (loaded?.toolNames ?? []).map((name) => {
      const matches = definitions.get(name) ?? []
      const definition = matches.shift()
      definitions.set(name, matches)
      return definition ?? emptyToolDefinition(name)
    })
    return {
      id: `${server.id}:${server.index}`,
      name: server.name,
      tools
    }
  })
  const otherTools = [...definitions.values()].flat()
  if (otherTools.length > 0) {
    groups.push({
      id: 'other',
      name: '',
      tools: otherTools
    })
  }
  return groups
}

function emptyToolDefinition(name: string, description = ''): RuntimeToolDefinition {
  return { name, description, parameters: [] }
}

export function toolDefinitionText(tool: RuntimeToolDefinition): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? {
      type: 'object',
      properties: Object.fromEntries(tool.parameters.map((parameter) => [
        parameter.name,
        {
          description: parameter.description,
          ...(parameter.schema && typeof parameter.schema === 'object'
            ? parameter.schema as Record<string, unknown>
            : {})
        }
      ]))
    }
  }, null, 2)
}

export function ToolsSettings({ actionsTarget, plugins, pluginError, customTools, onConfigChange, mcpServers, mcpStatus, runtimeToolStatus }: ToolsSettingsProps) {
  const { t, i18n } = useTranslation()
  const [selectedGroup, setSelectedGroup] = useState<'builtin' | 'mcp' | 'plugins' | 'customTools'>('builtin')
  const [selectedToolKey, setSelectedToolKey] = useState<string>()
  const [selectedFormat, setSelectedFormat] = useState<'json' | 'freeform'>('json')
  const [previewAccessMode, setPreviewAccessMode] = useState<AgentAccessMode>('smart_approval')
  const renderGroupTitle = (label: string) => (
    <strong className="settings-tool-group-title">{label}</strong>
  )
  const runtimeToolByName = useMemo(
    () => new Map((runtimeToolStatus?.tools ?? []).map((tool) => [runtimeToolSelectionId(tool), tool])),
    [runtimeToolStatus]
  )
  const mcpGroups = useMemo(
    () => mcpToolDisplayGroups(mcpStatus, mcpServers),
    [mcpServers, mcpStatus]
  )
  const pluginGroups = useMemo<ToolDisplayGroup[]>(() => plugins
    .filter(plugin => plugin.manifest?.tools.length || plugin.error)
    .map(plugin => ({
      id: plugin.id,
      name: pluginDisplayText(plugin, i18n.language),
      disabled: !plugin.enabled,
      error: plugin.error,
      tools: (plugin.manifest?.tools ?? []).map(tool => ({
        name: pluginToolName(plugin.id, tool.id),
        description: tool.description,
        inputSchema: tool.inputSchema,
        parameters: []
      }))
    })), [plugins, i18n.language])
  const catalogGroups = { mcp: mcpGroups, plugins: pluginGroups }
  const catalogLabels = { builtin: 'custom_tools.builtin', mcp: 'settings.mcp', plugins: 'plugins.title' }
  const toolDefinitions = useMemo(() => new Map([
    ...builtinToolCatalog.map((tool): [string, RuntimeToolDefinition] => [
      `runtime:${tool.id}`, runtimeToolByName.get(tool.id) ?? emptyToolDefinition(tool.id)
    ]),
    ...frameworkToolCatalog.map((tool): [string, RuntimeToolDefinition] => [
      `runtime:${tool.id}`, runtimeToolByName.get(tool.id) ?? emptyToolDefinition(tool.id, t(`settings.framework_tool_${tool.id}_hint`))
    ]),
    ...mcpGroups.flatMap((group) => group.tools.map((tool, index): [string, RuntimeToolDefinition] => [
      `mcp:${group.id}:${tool.name}:${index}`, tool
    ])),
    ...pluginGroups.flatMap((group) => group.tools.map((tool, index): [string, RuntimeToolDefinition] => [
      `plugins:${group.id}:${tool.name}:${index}`, tool
    ]))
  ]), [runtimeToolByName, mcpGroups, pluginGroups, t])
  const selectedTool = selectedToolKey ? toolDefinitions.get(selectedToolKey) : undefined
  const selectedVariant = selectedTool?.definitionVariants?.find(variant => variant.format === selectedFormat)
    ?? selectedTool?.definitionVariants?.[0]
  const smartDefinition = previewAccessMode === 'smart_approval' && selectedVariant?.format !== 'freeform'
    ? selectedTool?.smartApprovalDefinition : undefined
  const selectedToolText = smartDefinition ? JSON.stringify(smartDefinition, null, 2) : selectedVariant ? JSON.stringify(selectedVariant.definition, null, 2)
    : selectedTool ? toolDefinitionText(selectedTool) : ''
  function renderToolRow(key: string) {
    const tool = toolDefinitions.get(key)!
    return (
      <button
        aria-label={`${tool.name}: ${t('settings.tools_view_details')}`}
        className="settings-tool-catalog-row"
        key={key}
        type="button"
        onClick={() => { setSelectedFormat('json'); setSelectedToolKey(key) }}
      >
        <code className="settings-tool-catalog-name ui-tool-name">{tool.name}</code>
      </button>
    )
  }

  return (
    <>
      <CustomToolsGroup actionsTarget={actionsTarget} tools={customTools} onConfigChange={onConfigChange} onSelectCustom={() => setSelectedGroup('customTools')}
        catalogNavigation={<>{(['builtin', 'mcp', 'plugins'] as const).map(group => <button key={group} type="button"
          className={`ui-list-item ui-list-item-split${selectedGroup === group ? ' active' : ''}`} aria-pressed={selectedGroup === group}
          onClick={() => { setSelectedGroup(group); setSelectedToolKey(undefined) }}>
          <strong>{t(catalogLabels[group])}</strong>
          <em>{group === 'builtin' ? orderedToolCatalog.length : catalogGroups[group].reduce((total, source) => total + source.tools.length, 0)}</em>
        </button>)}</>}
        catalogView={selectedGroup === 'customTools' ? undefined : selectedGroup === 'mcp' || selectedGroup === 'plugins' ? <div className="ui-form-section settings-tool-group">
          {renderGroupTitle(t(catalogLabels[selectedGroup]))}
          {selectedGroup === 'plugins' && <>
            <small className="ui-field-hint">{t('plugins.tools_catalog_hint')}</small>
            {pluginError && <div className="ui-note ui-note-danger" role="alert">{t('plugins.load_failed')} {pluginError}</div>}
          </>}
          <div className="settings-tool-source-groups">
            {catalogGroups[selectedGroup].map(group => <section className="settings-tool-source-group" key={group.id}
              aria-label={group.name || t('settings.tools_mcp_other')}>
              <div className="settings-tool-source-group-header ui-row"><strong>{group.name || t('settings.tools_mcp_other')}</strong>
                <small>{t('settings.tools_count', { count: group.tools.length })}</small>
                {group.disabled && <small>{t('settings.disabled')}</small>}
              </div>
              {group.error && <div className="ui-note ui-note-danger" role="alert">{group.error}</div>}
              <div className="settings-tool-catalog">
                {group.tools.map((tool, index) => renderToolRow(`${selectedGroup}:${group.id}:${tool.name}:${index}`))}
                {!group.tools.length && !group.error && <div className="ui-field-hint">{t('settings.tools_mcp_server_empty')}</div>}
              </div>
            </section>)}
            {!catalogGroups[selectedGroup].length && !(selectedGroup === 'plugins' && pluginError) && <div className="ui-field-hint">
              {t(selectedGroup === 'mcp' ? 'settings.tools_mcp_empty' : 'plugins.tools_catalog_empty')}
            </div>}
          </div>
        </div> : <div className="ui-form-section">
          {renderGroupTitle(t('custom_tools.builtin'))}
          <small className="ui-field-hint">{t('settings.tools_page_hint')}</small>
          {toolGroupOrder.filter(group => orderedToolCatalog.some(tool => (tool.feature ?? tool.id) === group)).map(group =>
            <section className="settings-tool-catalog" key={group} aria-label={t(`settings.capability_${group}`)}>
              {renderGroupTitle(`${t(`settings.capability_${group}`)}：`)}
              {orderedToolCatalog.filter(tool => (tool.feature ?? tool.id) === group).map(tool => renderToolRow(`runtime:${tool.id}`))}
            </section>)}
        </div>}
      />

      {selectedTool && <ContentPreviewDialog title={selectedTool.name} description={t('settings.tool_definition_hint')}
        copyText={selectedToolText} onClose={() => setSelectedToolKey(undefined)}>
        {selectedTool.smartApprovalDefinition && <div className="settings-tool-definition-formats">
          <SegmentedControl<AgentAccessMode> ariaLabel={t('chat.access_mode')} value={previewAccessMode} onChange={setPreviewAccessMode}
            options={(['strict_approval', 'smart_approval', 'full_access'] as const).map(value => ({ value,
              label: t(value === 'full_access' ? 'chat.access_full' : `chat.access_${value}`) }))} />
        </div>}
        {selectedTool.definitionVariants && selectedVariant && <div className="settings-tool-definition-formats">
          <SegmentedControl<'json' | 'freeform'> ariaLabel={t('settings.tool_definition_format')} value={selectedVariant.format} onChange={setSelectedFormat}
            options={selectedTool.definitionVariants.map(variant => ({ value: variant.format,
              label: `${selectedTool.name} (${variant.format === 'json' ? 'JSON' : 'Freeform'})` }))} />
          <small className="ui-field-hint">{t(`settings.tool_definition_${selectedVariant.format}_hint`)}</small>
        </div>}
        <pre className="ui-code-block settings-code-preview-code">{selectedToolText}</pre>
      </ContentPreviewDialog>}
    </>
  )
}

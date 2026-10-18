import { usePlugins } from './plugins/usePlugins'
import { isPluginSkillId } from '@shared/pluginTools'
import { PluginCapabilitySelection } from './plugins/PluginCapabilitySelection'
import { setAllCustomTools, withToolShadows, resolveToolSelection } from '@shared/toolPackages'
import { SubagentSelectionEditor, type SubagentSelectionProps } from './SubagentSelectionEditor'
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, Plug, Trash2 } from 'lucide-react'
import { builtinToolCatalog, runtimeToolSelectionId } from '@shared/toolRegistry'
import { mcpServerSelection, removeEmptyMissingMcpSelections, setMcpServerMode, setMcpToolSelection, resolveSkillSelection, setToolSelection, toolAllowed, toolSelected, type AgentCapabilities } from '@shared/agentCapabilities'
import type { McpServerConfigDetail, McpToolStatus, RuntimeToolStatus, SkillSnapshot } from '@shared/types'
import { CheckboxField } from './CheckboxField'
import { CapabilitySection } from './CapabilitySection'
import { SkillAvailabilityNotice } from './SkillAvailabilityNotice'
import { SegmentedMultiSelect } from './SegmentedMultiSelect'
import { SettingsStatusIndicator } from './settings/SettingsStatusIndicator'
import { skillSourceGroups } from './skillSourceGroups'
import { UI_ICON_SIZE_MEDIUM, UI_ICON_SIZE_SMALL } from './uiConstants'

const capabilityGroupOrder = [
  'profile', 'environment', 'workspace', 'applicationEnvironment',
  'backgroundTools', 'planning', 'commandExecution', 'networkAccess',
  'configuration', 'request_user_input', 'sleep', 'fileRead', 'fileWrite', 'memory', 'customTools', 'subagents'
]

interface Props {
  customTools?: readonly import('@shared/toolPackages').ToolPackage[]
  value: AgentCapabilities
  skills?: SkillSnapshot
  mcpStatus?: McpToolStatus
  mcpServers?: readonly Pick<McpServerConfigDetail, 'id' | 'name' | 'enabled'>[]
  runtimeToolStatus?: RuntimeToolStatus
  subagents?: SubagentSelectionProps['definitions']
  subagent?: boolean
  disabled?: boolean
  toolbarEnd?: ReactNode
  onChange(value: AgentCapabilities): void
  onEnableAll?(capabilities: AgentCapabilities): void
}

export function CapabilityEditor({ customTools = [], value: storedValue, skills, mcpStatus, mcpServers = [], runtimeToolStatus, subagents = [], subagent = false, disabled = false, toolbarEnd, onChange: onValueChange, onEnableAll }: Props) {
  const { t } = useTranslation()
  const { plugins, error: pluginsError } = usePlugins()
  const ordinaryTools = builtinToolCatalog.filter((tool) => tool.feature !== 'backgroundTools')
  const servers = new Map(mcpServers.map((server) => [server.id, server]))
  const runtimeServers = new Map(mcpStatus?.servers.map((server) => [server.id, server]))
  for (const server of runtimeServers.values()) {
    if (!servers.has(server.id)) servers.set(server.id, { id: server.id, name: server.name, enabled: true })
  }
  const configuredIds = new Set(servers.keys())
  const value = removeEmptyMissingMcpSelections(storedValue, configuredIds)
  function onChange(next: AgentCapabilities): void {
    onValueChange(removeEmptyMissingMcpSelections(next, configuredIds))
  }
  for (const server of value.mcp.servers) {
    if (!servers.has(server.id)) servers.set(server.id, { id: server.id, name: server.id, enabled: false })
  }
  const mcpGroups = [...servers.values()].map((server) => {
    const runtime = runtimeServers.get(server.id)
    const liveNames = new Set(runtime?.toolNames)
    const unavailable = !server.enabled || runtime?.state !== 'ready'
    return {
      id: server.id, name: server.name, enabled: server.enabled, unavailable,
      selection: mcpServerSelection(value.mcp, server.id),
      tools: [...new Set([...liveNames, ...mcpServerSelection(value.mcp, server.id).tools])].map((name) => ({
        name, known: liveNames.has(name), unavailable: unavailable || !liveNames.has(name)
      }))
    }
  })
  const catalogToolIds = new Set<string>(builtinToolCatalog.map((tool) => tool.id))
  const missingTools = value.tools.filter((id) => !catalogToolIds.has(id))
  const selectedCustomTools = resolveToolSelection(value.customTools, customTools.filter(tool => value.backgroundTools || !tool.definition?.interactive), subagent, false)
  const customToolItems = withToolShadows(customTools.filter(tool => !subagent || tool.source !== 'project'), selectedCustomTools.entries)
  type CapabilityFlag = 'profile' | 'environment' | 'workspace' | 'memory' | 'applicationEnvironment' | 'backgroundTools' | 'planning'
  const groups: Array<{ id: string; name: string; flag?: CapabilityFlag; tools: Array<{ id: string; name: string; unavailable?: boolean; missing?: boolean; requiresBackground?: boolean; shadowedBy?: string; ariaLabel?: string; sourceId?: string; sourceName?: string }> }> = [
    ...(['profile', 'environment', 'workspace', 'applicationEnvironment', 'backgroundTools', 'planning'] as const).map((flag) => ({
      id: flag, name: t(`settings.capability_${flag === 'workspace' ? 'workspaceContext' : flag}`), flag, tools: []
    })),
    ...(['commandExecution', 'networkAccess', 'fileRead', 'fileWrite', 'configuration', 'memory'] as const).map((feature) => ({
      id: feature, name: t(`settings.capability_${feature}`),
      ...(feature === 'memory' ? { flag: 'memory' as const } : {}),
      tools: ordinaryTools.filter((tool) => tool.feature === feature).map((tool) => ({
        id: tool.id,
        name: runtimeToolStatus?.tools.find((entry) => runtimeToolSelectionId(entry) === tool.id)?.name ?? tool.id
      }))
    })),
    ...ordinaryTools.filter((tool) => tool.feature === undefined).map((tool) => ({
      id: tool.id, name: t(`settings.capability_${tool.id}`, { defaultValue: tool.id }),
      tools: [{ id: tool.id, name: tool.id }]
    })),
    { id: 'customTools', name: t('custom_tools.title'), tools: [
      ...customToolItems.map((tool) => ({ id: tool.id, name: tool.name, unavailable: tool.enabled === false || Boolean(tool.error), missing: !tool.definition,
        sourceId: tool.rootId, sourceName: tool.source === 'user' ? t('settings.skill_group_user') : tool.rootName,
        ariaLabel: `${tool.rootName} ${tool.name}`, shadowedBy: tool.shadowedBy, requiresBackground: tool.definition?.interactive && !value.backgroundTools })),
      ...value.customTools.entries.filter((id) => !customTools.some((tool) => tool.id === id)).map((id) => ({ id, name: id, unavailable: true, missing: true }))
    ] },
    ...(missingTools.length ? [{ id: 'missing-tools', name: t('capabilities.other_tools'), tools: missingTools.map((id) => ({ id, name: id, unavailable: true })) }] : [])
  ]
  function renderCapabilityTool(group: typeof groups[number], tool: typeof groups[number]['tools'][number]) {
    return <CheckboxField className="ui-checkbox-field-inline" key={tool.id} disabled={group.id === 'customTools' && tool.missing && !value.customTools.entries.includes(tool.id)} checked={group.id === 'customTools' ? value.customTools.entries.includes(tool.id) : toolSelected(value, tool.id)} aria-label={tool.ariaLabel ?? tool.name} label={<span className="ui-row"><code className="ui-tool-name">{tool.name}</code>{tool.unavailable && <span className="ui-badge">{t('capabilities.inactive')}</span>}{tool.shadowedBy && <span className="ui-badge" data-tooltip={t('custom_tools.shadowed_by', { source: tool.shadowedBy })}>{t('custom_tools.shadowed')}</span>}{tool.requiresBackground && <span className="ui-badge">{t('custom_tools.requires_background')}</span>}</span>}
                    onChange={(checked) => onChange(selectGroupTools(group, [tool.id], checked))} />
  }
  const isDirectToggle = (group: typeof groups[number]) => (group.tools.length === 1 && group.id !== 'missing-tools' && group.id !== 'customTools') || (!group.tools.length && Boolean(group.flag))
  const groupOrder = new Map<string, number>(capabilityGroupOrder.map((id, index) => [id, index]))
  const orderedGroups = [...groups].sort((a, b) => (groupOrder.get(a.id) ?? groupOrder.size) - (groupOrder.get(b.id) ?? groupOrder.size))
  function setTools(ids: string[], checked: boolean) {
    onChange(setToolSelection(value, ids, checked))
  }
  function selectGroupTools(group: typeof groups[number], ids: string[], checked: boolean): AgentCapabilities {
    if (group.id !== 'customTools') return setToolSelection(value, ids, checked)
    const retained = value.customTools.entries.filter((id) => !ids.includes(id))
    return { ...value, customTools: { ...value.customTools, mode: 'custom', entries: checked ? [...retained, ...ids] : retained } }
  }
  const visibleSkills = (skills?.skills ?? []).filter((skill) => skill.source !== 'plugin' && (!subagent || skill.source !== 'project'))
  const effectiveSkills = resolveSkillSelection(value.skills, visibleSkills, false, subagent, value.pluginTools)
  const selectedSkills = new Map((value.skills.mode === 'custom' ? value.skills.entries : effectiveSkills.entries).map((entry) => [entry.id, entry]))
  const skillRootIds = new Set(skills?.roots.map((root) => root.id))
  const missingSkills = [
    ...visibleSkills.filter((skill) => !skillRootIds.has(skill.rootId)).map((skill) => ({ ...skill, unavailable: true })),
    ...value.skills.entries.filter((entry) => !isPluginSkillId(entry.id) && !skills?.skills.some((skill) => skill.id === entry.id)).map((entry) => ({ id: entry.id, name: entry.id, description: entry.id, unavailable: true, missing: Boolean(skills) }))
  ]
  const projectSkillsSelected = subagent && value.skills.mode === 'custom' && value.skills.project
  const selectedSkillCount = effectiveSkills.entries.filter((entry) => entry.model || (!subagent && entry.shortcut)).length
  const skillWarning = (effectiveSkills.entries.some((entry) => entry.model || (!subagent && entry.shortcut))
    || projectSkillsSelected)
    && !['run_shell', 'read_file', 'read_multiple_files'].some((id) => toolAllowed(value, id))
  function setSkill(id: string, key: 'shortcut' | 'model', enabled: boolean) {
    const entries = value.skills.entries.filter((entry) => entry.id !== id)
    const current = value.skills.entries.find((entry) => entry.id === id) ?? { id, shortcut: false, model: false }
    onChange({ ...value, skills: { ...value.skills, entries: [...entries, { ...current, [key]: enabled }] } })
  }
  function renderSkill(skill: { id: string; name: string; description: string; unavailable: boolean; missing?: boolean; modelAvailable?: boolean; userAvailable?: boolean; source?: string; requiredTools?: string[] }) {
    const missing = skill.requiredTools?.filter(id => !value.pluginTools.includes(id)) ?? []
    const selected = selectedSkills.get(skill.id)
    const modelUnavailable = skill.unavailable || (skill.source !== 'project' && skill.modelAvailable === false)
    const shortcutUnavailable = skill.unavailable || (skill.source !== 'project' && skill.userAvailable === false)
    return <div className="ui-capability-skill" key={skill.id}>
      <span className="ui-field-stack"><span className="ui-row">
        <code className="ui-truncate" data-tooltip={skill.description}>{skill.name}</code>
        {(skill.unavailable || missing.length > 0) && <span className="ui-badge">{t('capabilities.inactive')}</span>}
        {missing.length > 0 && <SettingsStatusIndicator label={t('plugins.missing_tools')} hint={t('plugins.missing_tools_detail', { tools: missing.join(', ') })} />}
        {skill.missing && <button type="button" className="ui-icon-button"
          aria-label={`${t('capabilities.remove_missing_skill')}: ${skill.name}`}
          data-tooltip={t('capabilities.remove_missing_skill')}
          onClick={() => onChange({ ...value, skills: { ...value.skills, entries: value.skills.entries.filter((entry) => entry.id !== skill.id) } })}>
          <Trash2 size={UI_ICON_SIZE_SMALL} />
        </button>}
      </span><SkillAvailabilityNotice skill={skill} selected={selected} subagent={subagent} /></span>
      {subagent
        ? <CheckboxField className="ui-checkbox-field-inline" checked={selected?.model ?? false} disabled={modelUnavailable && !selected?.model} label="" aria-label={`${skill.name} ${t('capabilities.model')}`} onChange={(checked) => setSkill(skill.id, 'model', checked)} />
        : <SegmentedMultiSelect<'shortcut' | 'model'> ariaLabel={skill.name}
          options={[
            { value: 'shortcut', label: t('capabilities.shortcut'), ariaLabel: `${skill.name} ${t('capabilities.shortcut')}`, checked: selected?.shortcut ?? false, disabled: shortcutUnavailable && !selected?.shortcut },
            { value: 'model', label: t('capabilities.model'), ariaLabel: `${skill.name} ${t('capabilities.model')}`, checked: selected?.model ?? false, disabled: modelUnavailable && !selected?.model }
          ]}
          onChange={(key, checked) => setSkill(skill.id, key, checked)} />}
    </div>
  }
  function setAll(checked: boolean) {
    const pluginIds = new Set([...plugins.map(plugin => plugin.id), ...(value.plugins ?? []).map(plugin => plugin.id),
      ...[...value.pluginTools, ...value.pluginPrompts, ...value.skills.entries.filter(entry => isPluginSkillId(entry.id)).map(entry => entry.id)].map(id => id.split(':')[0])])
    const next: AgentCapabilities = { ...value,
      profile: checked, environment: checked, workspace: checked, memory: checked,
      applicationEnvironment: checked, backgroundTools: checked, planning: checked,
      toolMode: checked ? 'all' : 'selected', tools: [],
      pluginMode: 'custom', plugins: [...pluginIds].map(id => ({ id, mode: checked ? 'all' : 'off' })),
      customTools: setAllCustomTools(value.customTools, checked),
      mcp: { defaultMode: 'selected', servers: mcpGroups.map(group => ({ ...group.selection, mode: checked ? 'all' : 'off' })) },
      skills: { ...value.skills, mode: checked ? 'default' : 'off' },
      subagents: { ...value.subagents, mode: checked ? 'default' : 'off' }
    }
    if (checked && onEnableAll) onEnableAll(next)
    else onChange(next)
  }
  return (
    <fieldset className="ui-page-section ui-surface-flat" aria-label={t('settings.capabilities')} disabled={disabled}>
      <div className="ui-capability-editor">
        <div className="ui-toolbar ui-toolbar-between">
          {subagent && <strong className="ui-section-title">{t('settings.capabilities')}</strong>}
          <div className="ui-toolbar">
            <button type="button" className="ui-button ui-button-compact" onClick={() => setAll(true)}>{t('settings.capabilities_enable_all')}</button>
            <button type="button" className="ui-button ui-button-compact" onClick={() => setAll(false)}>{t('settings.capabilities_disable_all')}</button>
          </div>
          {toolbarEnd}
        </div>
        <div className="ui-grid-auto">
          {orderedGroups.map((group) => {
            if (isDirectToggle(group)) return <CheckboxField className="ui-checkbox-field-inline" key={group.id}
              checked={group.flag ? value[group.flag] : group.tools.some((tool) => toolAllowed(value, tool.id))}
              aria-label={group.name} label={<span className="ui-row">{group.name}{group.tools[0]?.unavailable && <span className="ui-badge">{t('capabilities.inactive')}</span>}</span>}
              tooltip={group.flag === 'applicationEnvironment' ? t('capabilities.environment_hint') : undefined}
              onChange={(checked) => group.flag ? onChange({ ...value, [group.flag]: checked }) : setTools(group.tools.map((tool) => tool.id), checked)} />
            if (group.id === 'customTools') return <CapabilitySection key={group.id} label={group.name}
              count={customToolItems.filter(tool => !tool.shadowedBy && selectedCustomTools.entries.includes(tool.id)).length}
              mode={value.customTools.mode ?? 'custom'} disabled={disabled}
              onChange={mode => onChange({ ...value, customTools: { ...value.customTools, mode } })}>
              <div className="ui-capability-list ui-capability-tools">
                {subagent && <CheckboxField className="ui-checkbox-field-inline" checked={value.customTools.project} label={t('custom_tools.project_tools')}
                  onChange={project => onChange({ ...value, customTools: { ...value.customTools, project } })} />}
                {[...new Set(group.tools.map(tool => tool.sourceId ?? 'missing'))].map(id => <div className="ui-form-section" key={id}>
                  <strong>{group.tools.find(tool => (tool.sourceId ?? 'missing') === id)?.sourceName ?? t('capabilities.other_tools')}</strong>
                  <div className="ui-grid-auto">{group.tools.filter(tool => (tool.sourceId ?? 'missing') === id).map(tool => renderCapabilityTool(group, tool))}</div>
                </div>)}
                {!group.tools.length && <small>{t('custom_tools.empty')}</small>}
              </div>
            </CapabilitySection>
            const total = group.tools.length + (group.flag ? 1 : 0)
            const count = group.tools.filter(tool => toolAllowed(value, tool.id)).length + (group.flag && value[group.flag] ? 1 : 0)
            const toggle = (checked: boolean) => onChange({ ...selectGroupTools(group, group.tools.map(tool => tool.id), checked),
              ...(group.flag ? { [group.flag]: checked } : {}) })
            return <div className="ui-capability-group" key={group.id}>
              <CheckboxField className="ui-checkbox-field-inline" checked={count === total && count > 0} indeterminate={count > 0 && count < total}
                aria-label={group.name} label="" disabled={total === 0} onChange={toggle} />
              <details>
                <summary>{group.name} <small>{count}/{total}</small></summary>
                <fieldset className={`ui-capability-list ui-capability-tools${group.id === 'customTools' ? '' : ' ui-grid-auto'}`}>
                  {group.flag && <CheckboxField className="ui-checkbox-field-inline" checked={value[group.flag]}
                    label={t('settings.capability_memory_recall')} onChange={(checked) => onChange({ ...value, [group.flag!]: checked })} />}
                  {group.tools.map(tool => renderCapabilityTool(group, tool))}
                </fieldset>
              </details>
            </div>
          })}
        </div>
        {mcpGroups.length > 0 && <div className="ui-form-section ui-form-section-divided">
          {mcpGroups.map(group => <CapabilitySection key={group.id} label={group.name}
            title={<><Plug className="ui-muted" size={UI_ICON_SIZE_MEDIUM} aria-hidden="true" /><span>{group.name}</span></>}
            count={group.selection.mode === 'all' ? group.tools.filter(tool => !tool.unavailable).length : group.selection.mode === 'off' ? 0 : group.tools.filter(tool => !tool.unavailable && group.selection.tools.includes(tool.name)).length}
            mode={group.selection.mode === 'selected' ? 'custom' : group.selection.mode} disabled={disabled}
            reason={group.unavailable ? t('capabilities.inactive') : undefined}
            onChange={mode => onChange(setMcpServerMode(value, group.id, mode === 'custom' ? 'selected' : mode))}>
            <div className="ui-capability-list ui-capability-tools ui-grid-auto">
              {!group.tools.length && <small>{t('capabilities.no_known_mcp_tools')}</small>}
              {group.tools.map(tool => <CheckboxField className="ui-checkbox-field-inline" key={tool.name} aria-label={`${group.name} ${tool.name}`}
                label={<span className="ui-row"><code className="ui-tool-name">{tool.name}</code>{tool.unavailable && <span className="ui-badge">{t('capabilities.inactive')}</span>}</span>}
                disabled={disabled || (!tool.known && !group.selection.tools.includes(tool.name))} checked={group.selection.tools.includes(tool.name)}
                onChange={checked => onChange(setMcpToolSelection(value, group.id, tool.name, checked))} />)}
            </div>
          </CapabilitySection>)}
        </div>}
        <PluginCapabilitySelection plugins={plugins} error={pluginsError} value={value} skills={skills} subagent={subagent} onChange={onChange} />
        <SubagentSelectionEditor value={value.subagents} definitions={subagents} disabled={disabled}
          onChange={(subagents) => onChange({ ...value, subagents })} />
        <div className="ui-form-section ui-form-section-divided">
          <CapabilitySection label={t('settings.capability_skills')} count={<>{selectedSkillCount}{projectSkillsSelected && <> + {t('settings.skill_group_project')}</>}</>}
            mode={value.skills.mode === 'default' ? 'all' : value.skills.mode} disabled={disabled}
            reason={skillWarning ? t('settings.subagent_skills_require_file_read') : undefined}
            onChange={mode => onChange({ ...value, skills: { ...value.skills, mode: mode === 'all' ? 'default' : mode } })}>
          <div className="ui-capability-editor">
            {value.skills.mode === 'custom' && <>
              <div className="ui-capability-list">
                {skillSourceGroups((skills?.roots ?? []).filter(root => root.kind !== 'plugin'), t).map((group) => {
                  if (subagent && group.id === 'project') return <div className="ui-capability-skill" key={group.id}>
                    <span className="ui-row"><Folder size={UI_ICON_SIZE_MEDIUM} aria-hidden="true" /><span>{t('capabilities.project_skills')}</span></span>
                    <CheckboxField
                      className="ui-checkbox-field-inline"
                      checked={value.skills.project}
                      label=""
                      aria-label={t('capabilities.project_skills')}
                      tooltip={t('capabilities.project_skills_hint')}
                      onChange={(project) => onChange({ ...value, skills: { ...value.skills, project } })}
                    />
                  </div>
                  const rootIds = new Set(group.roots.map((root) => root.id))
                  const items = (skills?.skills ?? []).filter((skill) => rootIds.has(skill.rootId))
                  if (!items.length) return null
                  return <div className="ui-form-section" key={group.id}>
                    <strong className="ui-row"><Folder size={UI_ICON_SIZE_MEDIUM} aria-hidden="true" /><span>{group.label} <small>{effectiveSkills.entries.filter(entry => items.some(skill => skill.id === entry.id) && (entry.model || (!subagent && entry.shortcut))).length}/{items.length}</small></span></strong>
                    {group.roots.map((root) => {
                      const rootItems = items.filter((skill) => skill.rootId === root.id)
                      if (!rootItems.length) return null
                      return <div className="ui-form-section" key={root.id}>
                        {group.roots.length > 1 && <strong className="ui-row"><Folder size={UI_ICON_SIZE_MEDIUM} aria-hidden="true" /><span>{root.name}</span></strong>}
                        {rootItems.map((skill) => renderSkill({ ...skill, unavailable: Boolean(skill.loadError) }))}
                      </div>
                    })}
                  </div>
                })}
                {missingSkills.length > 0 && <div className="ui-form-section">
                  <strong>{t('capabilities.other_skills')}</strong>
                  {missingSkills.map(renderSkill)}
                </div>}
                {!skills && <small>{t('capabilities.loading')}</small>}
              </div>
            </>}
          </div>
          </CapabilitySection>
        </div>
      </div>
    </fieldset>
  )
}

import { usePlugins } from './plugins/usePlugins'
import { isPluginSkillId } from '@shared/pluginTools'
import { PluginCapabilitySelection } from './plugins/PluginCapabilitySelection'
import { setAllCustomTools, type ToolRoot } from '@shared/toolPackages'
import { SubagentSelectionEditor, type SubagentSelectionProps } from './SubagentSelectionEditor'
import { SubagentPackagePanel } from './subagent/SubagentPackagePanel'
import { packageResourceKey } from '@shared/packageResourceSelection'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Folder, Plug, Trash2 } from 'lucide-react'
import { builtinToolCatalog, runtimeToolSelectionId } from '@shared/toolRegistry'
import { mcpGroupMode, mcpServerSelection, removeEmptyMissingMcpSelections, setMcpServerMode, setMcpToolSelection, resolveSkillSelection, setSkillSelection, setToolSelection, toolAllowed, toolSelected, type AgentCapabilities } from '@shared/agentCapabilities'
import type { McpServerConfigDetail, McpToolStatus, RuntimeToolStatus, SkillSnapshot, SkillSummary } from '@shared/types'
import { CheckboxField } from './CheckboxField'
import { Checkbox } from './Checkbox'
import { CapabilitySection } from './CapabilitySection'
import { SkillAvailabilityNotice } from './SkillAvailabilityNotice'
import { SegmentedMultiSelect } from './SegmentedMultiSelect'
import { SettingsStatusIndicator } from './settings/SettingsStatusIndicator'
import { skillSourceGroups } from './skillSourceGroups'
import { UI_ICON_SIZE_MEDIUM, UI_ICON_SIZE_SMALL } from './uiConstants'
import { ProjectSkillGroup } from './projects/ProjectSkillGroup'
import { CapabilityResourceGroup } from './CapabilityResourceGroup'
import { CapabilityResourceName } from './CapabilityResource'
import { CustomToolSelectionEditor } from './CustomToolSelectionEditor'

const capabilityGroupOrder = [
  'profile', 'environment', 'workspace', 'applicationEnvironment',
  'backgroundTools', 'planning', 'commandExecution', 'networkAccess',
  'configuration', 'request_user_input', 'sleep', 'memory', 'fileRead', 'fileWrite'
]

interface Props {
  customTools?: readonly import('@shared/toolPackages').ToolPackage[]
  customToolRoots?: readonly ToolRoot[]
  value: AgentCapabilities
  skills?: SkillSnapshot
  mcpStatus?: McpToolStatus
  mcpServers?: readonly Pick<McpServerConfigDetail, 'id' | 'name' | 'enabled'>[]
  runtimeToolStatus?: RuntimeToolStatus
  subagents?: SubagentSelectionProps['definitions']
  subagent?: boolean
  subagentId?: string
  restrictSubagents?: boolean
  disabled?: boolean
  toolbarEnd?: ReactNode
  projectSkills?: {
    disabled?: boolean
    scriptAutoApproveSkills: readonly string[]
    onChangeScriptAutoApprove(id: string, enabled: boolean): void
    onAddDirectories(): void
    onRemoveDirectory(path: string): void
  }
  onChange(value: AgentCapabilities): void
  onEnableAll?(capabilities: AgentCapabilities): void
}

export function CapabilityEditor({ customTools: globalTools = [], customToolRoots, value: storedValue, skills: globalSkills, mcpStatus, mcpServers = [], runtimeToolStatus, subagents = [], subagent = false, subagentId, restrictSubagents = false, disabled = false, toolbarEnd, projectSkills, onChange: onValueChange, onEnableAll }: Props) {
  const { t } = useTranslation()
  const [packageCatalog, setPackageCatalog] = useState<{ key: string; resources?: Awaited<ReturnType<typeof window.gale.config.subagentResources>>; error?: string }>()
  const packageIds = subagent ? (subagentId ? `agent:${subagentId}` : '')
    : restrictSubagents ? subagents.flatMap(a => a.id ? [a.id] : []).join(',') : ''
  useEffect(() => {
    let active = true
    if (!packageIds) return
    window.gale.config.subagentResources(subagent ? subagentId : undefined)
      .then(resources => { if (active) setPackageCatalog({ key: packageIds, resources }) })
      .catch(reason => { if (active) setPackageCatalog({ key: packageIds, error: String(reason) }) })
    return () => { active = false }
  }, [packageIds, subagent, subagentId])
  const catalog = packageIds && packageCatalog?.key === packageIds ? packageCatalog : undefined
  const packageError = catalog?.error
  const ownResources = subagent ? catalog?.resources : undefined
  const resources = subagent ? undefined : catalog?.resources
  const packageSelectionPending = Boolean(subagent && subagentId && !ownResources)
  const skillSelectionPending = Boolean(projectSkills && (!globalSkills || (packageIds && !catalog?.resources)))
  const customTools = [...globalTools, ...(resources?.tools ?? []).map(tool => ({ ...tool, rootName: t('settings.subagent_resource_source', { name: tool.rootName }) }))]
  const skills = resources ? { ...globalSkills, scriptAutoApprove: globalSkills?.scriptAutoApprove ?? false,
    roots: [...(globalSkills?.roots ?? []), ...resources.skills.roots.map(root => ({ ...root, name: t('settings.subagent_resource_source', { name: root.name }) }))], skills: [...(globalSkills?.skills ?? []), ...resources.skills.skills.map(skill => ({ ...skill, rootName: t('settings.subagent_resource_source', { name: skill.rootName }) }))] } : globalSkills
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
  const overallMcpMode = mcpGroupMode(value.mcp)
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
  type CapabilityFlag = 'profile' | 'environment' | 'workspace' | 'memory' | 'applicationEnvironment' | 'backgroundTools' | 'planning'
  const groups: Array<{ id: string; name: string; flag?: CapabilityFlag; tools: Array<{ id: string; name: string; unavailable?: boolean }> }> = [
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
    ...(missingTools.length ? [{ id: 'missing-tools', name: t('capabilities.other_tools'), tools: missingTools.map((id) => ({ id, name: id, unavailable: true })) }] : [])
  ]
  function renderCapabilityTool(tool: typeof groups[number]['tools'][number]) {
    return <CheckboxField key={tool.id} checked={toolSelected(value, tool.id)} aria-label={tool.name}
      label={<span className="ui-row"><code className="ui-tool-name">{tool.name}</code>{tool.unavailable && <span className="ui-badge">{t('capabilities.inactive')}</span>}</span>}
      onChange={checked => setTools([tool.id], checked)} />
  }
  const isDirectToggle = (group: typeof groups[number]) => (group.tools.length === 1 && group.id !== 'missing-tools') || (!group.tools.length && Boolean(group.flag))
  const groupOrder = new Map<string, number>(capabilityGroupOrder.map((id, index) => [id, index]))
  const orderedGroups = [...groups].sort((a, b) => (groupOrder.get(a.id) ?? groupOrder.size) - (groupOrder.get(b.id) ?? groupOrder.size))
  function setTools(ids: string[], checked: boolean) {
    onChange(setToolSelection(value, ids, checked))
  }
  const visibleSkills = (skills?.skills ?? []).filter((skill) => skill.source !== 'plugin' && (!subagent || skill.source !== 'project'))
  const effectiveSkills = resolveSkillSelection(value.skills, visibleSkills, false, subagent, value.pluginTools)
  const selectedSkills = new Map((value.skills.mode === 'custom' ? value.skills.entries : effectiveSkills.entries).map((entry) => [entry.id, entry]))
  const skillSelectionDisabled = value.skills.mode !== 'custom' || skillSelectionPending
  const skillRootIds = new Set(skills?.roots.map((root) => root.id))
  const missingSkills = [
    ...visibleSkills.filter((skill) => !skillRootIds.has(skill.rootId)).map((skill) => ({ ...skill, unavailable: true })),
    ...value.skills.entries.filter((entry) => !isPluginSkillId(entry.id) && !skills?.skills.some((skill) => skill.id === entry.id)).map((entry) => ({ id: entry.id, name: entry.id, description: entry.id, unavailable: true, missing: Boolean(skills) }))
  ]
  const projectSkillsSelected = subagent && value.skills.mode === 'custom' && value.skills.project
  const skillIds = new Set([...visibleSkills, ...missingSkills].map(skill => skill.id))
  function isSkillSelected(id: string) {
    const selection = selectedSkills.get(id)
    return selection?.model || (!subagent && selection?.shortcut)
  }
  const skillWarning = (effectiveSkills.entries.some((entry) => entry.model || (!subagent && entry.shortcut))
    || projectSkillsSelected)
    && !['run_shell', 'read_file', 'read_multiple_files'].some((id) => toolAllowed(value, id))
  function setSkill(id: string, key: 'shortcut' | 'model', enabled: boolean) {
    onChange({ ...value, skills: setSkillSelection(value.skills, skills?.skills ?? [], id, key, enabled) })
  }
  function renderSkill(skill: { id: string; name: string; description: string; unavailable: boolean; missing?: boolean; modelAvailable?: boolean; userAvailable?: boolean; source?: string; requiredTools?: string[]; dirPath?: string; loadError?: SkillSummary['loadError'] }) {
    const missing = skill.requiredTools?.filter(id => !value.pluginTools.includes(id)) ?? []
    const selected = selectedSkills.get(skill.id)
    const modelUnavailable = skill.unavailable || (skill.source !== 'project' && skill.modelAvailable === false)
    const shortcutUnavailable = skill.unavailable || (skill.source !== 'project' && skill.userAvailable === false)
    const projectControls = skill.source === 'project' ? projectSkills : undefined
    const scriptAutoApprove = projectControls?.scriptAutoApproveSkills.includes(skill.id) ?? false
    const name = <CapabilityResourceName name={skill.name} description={skill.description} directory={skill.dirPath} highlighted={scriptAutoApprove} />
    const status = <>
        {(skill.unavailable || missing.length > 0) && <span className="ui-badge">{t('capabilities.inactive')}</span>}
        {missing.length > 0 && <SettingsStatusIndicator label={t('plugins.missing_tools')} hint={t('plugins.missing_tools_detail', { tools: missing.join(', ') })} />}
        {skill.missing && <button type="button" className="ui-icon-button"
          disabled={skillSelectionDisabled}
          aria-label={`${t('capabilities.remove_missing_skill')}: ${skill.name}`}
          data-tooltip={t('capabilities.remove_missing_skill')}
          onClick={() => onChange({ ...value, skills: { ...value.skills, entries: value.skills.entries.filter((entry) => entry.id !== skill.id) } })}>
          <Trash2 size={UI_ICON_SIZE_SMALL} />
        </button>}
    </>
    if (subagent || skill.source === 'subagent') return <div className="ui-field-stack" key={skill.id}>
      <div className="ui-capability-resource">
        {skill.dirPath ? <div className="ui-row">
          <Checkbox checked={selected?.model ?? false} disabled={skillSelectionDisabled || (modelUnavailable && !selected?.model)}
            aria-label={`${skill.name} ${t('capabilities.model')}`} onChange={checked => setSkill(skill.id, 'model', checked)} />
          {name}
        </div> : <CheckboxField checked={selected?.model ?? false} disabled={skillSelectionDisabled || (modelUnavailable && !selected?.model)}
          label={skill.name} tooltip={skill.description} aria-label={`${skill.name} ${t('capabilities.model')}`}
          onChange={checked => setSkill(skill.id, 'model', checked)} />}
        {status}
      </div>
      <SkillAvailabilityNotice skill={skill} selected={selected} subagent />
    </div>
    return <div className="ui-capability-resource" key={skill.id}>
      <span className="ui-field-stack"><span className="ui-row">
        {name}
        {status}
      </span><SkillAvailabilityNotice skill={skill} selected={selected} />
        {projectControls && skill.loadError && <span role="alert" className="ui-field-hint ui-status-danger">{t(`settings.skill_issue_${skill.loadError.code}`, {
          name: skill.loadError.name, expected: skill.loadError.expected
        })}</span>}
      </span>
      <SegmentedMultiSelect<'shortcut' | 'model' | 'scriptAutoApprove'> ariaLabel={skill.name} disabled={projectControls?.disabled}
          options={[
            { value: 'shortcut', label: t('capabilities.shortcut'), ariaLabel: `${skill.name} ${t('capabilities.shortcut')}`, checked: selected?.shortcut ?? false, disabled: skillSelectionDisabled || (shortcutUnavailable && !selected?.shortcut) },
            { value: 'model', label: t('capabilities.model'), ariaLabel: `${skill.name} ${t('capabilities.model')}`, checked: selected?.model ?? false, disabled: skillSelectionDisabled || (modelUnavailable && !selected?.model) },
            ...(projectControls ? [{ value: 'scriptAutoApprove' as const, label: t('capabilities.script_auto_approve'), ariaLabel: `${skill.name} ${t('capabilities.script_auto_approve')}`, checked: scriptAutoApprove, disabled: skill.unavailable && !scriptAutoApprove }] : [])
          ]}
          onChange={(key, checked) => key === 'scriptAutoApprove' ? projectControls?.onChangeScriptAutoApprove(skill.id, checked) : setSkill(skill.id, key, checked)} />
    </div>
  }
  function setAll(checked: boolean) {
    const next: AgentCapabilities = { ...value,
      profile: checked, environment: checked, workspace: checked, memory: checked,
      applicationEnvironment: checked, backgroundTools: checked, planning: checked,
      toolMode: checked ? 'all' : 'selected', tools: [],
      pluginGroupMode: checked ? 'all' : 'off',
      customTools: setAllCustomTools(value.customTools, checked),
      mcp: { ...value.mcp, mode: checked ? 'all' : 'off' },
      skills: { ...value.skills, mode: checked ? 'default' : 'off' },
      subagents: { ...value.subagents, mode: checked ? 'default' : 'off' }
    }
    if (ownResources) {
      for (const [group, items] of [['skills', ownResources.skills.skills], ['customTools', ownResources.tools]] as const) {
        const keys = new Set([...Object.keys(value[group].package ?? {}), ...items.map(packageResourceKey)])
        if (keys.size) next[group].package = Object.fromEntries([...keys].map(key => [key, checked]))
      }
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
            <button type="button" className="ui-button ui-button-compact" disabled={packageSelectionPending} onClick={() => setAll(true)}>{t('settings.capabilities_enable_all')}</button>
            <button type="button" className="ui-button ui-button-compact" disabled={packageSelectionPending} onClick={() => setAll(false)}>{t('settings.capabilities_disable_all')}</button>
          </div>
          {packageError && <p role="alert" className="ui-status-danger">{packageError}</p>}{toolbarEnd}
        </div>
        <div className="ui-grid-auto">
          {orderedGroups.map((group) => {
            if (isDirectToggle(group)) return <CheckboxField className="ui-checkbox-field-inline" key={group.id}
              checked={group.flag ? value[group.flag] : group.tools.some((tool) => toolAllowed(value, tool.id))}
              aria-label={group.name} label={<span className="ui-row">{group.name}{group.tools[0]?.unavailable && <span className="ui-badge">{t('capabilities.inactive')}</span>}</span>}
              tooltip={group.flag === 'applicationEnvironment' ? t('capabilities.environment_hint') : undefined}
              onChange={(checked) => group.flag ? onChange({ ...value, [group.flag]: checked }) : setTools(group.tools.map((tool) => tool.id), checked)} />
            const total = group.tools.length + (group.flag ? 1 : 0)
            const count = group.tools.filter(tool => toolAllowed(value, tool.id)).length + (group.flag && value[group.flag] ? 1 : 0)
            const toggle = (checked: boolean) => onChange({ ...setToolSelection(value, group.tools.map(tool => tool.id), checked),
              ...(group.flag ? { [group.flag]: checked } : {}) })
            return <div className="ui-capability-group" key={group.id}>
              <CheckboxField className="ui-checkbox-field-inline" checked={count === total && count > 0} indeterminate={count > 0 && count < total}
                aria-label={group.name} label="" disabled={total === 0} onChange={toggle} />
              <details>
                <summary className="ui-disclosure-trigger">{group.name} <small className="ui-disclosure-count"><span>{count}/{total}</span><ChevronRight className="ui-disclosure-chevron" size={UI_ICON_SIZE_SMALL} aria-hidden="true" /></small></summary>
                <fieldset className="ui-capability-list ui-capability-tools ui-grid-auto ui-resource-grid">
                  {group.flag && <CheckboxField checked={value[group.flag]}
                    label={t('settings.capability_memory_recall')} onChange={(checked) => onChange({ ...value, [group.flag!]: checked })} />}
                  {group.tools.map(renderCapabilityTool)}
                </fieldset>
              </details>
            </div>
          })}
        </div>
        <CustomToolSelectionEditor value={value.customTools} tools={customTools} roots={customToolRoots} subagent={subagent}
          backgroundTools={value.backgroundTools} disabled={disabled} onChange={customTools => onChange({ ...value, customTools })} />
        {mcpGroups.length > 0 && <div className="ui-form-section ui-form-section-divided">
          <CapabilitySection label={t('settings.capability_mcp')} mode={overallMcpMode} expandable disabled={disabled}
            customCount={mcpGroups.filter(group => group.selection.mode !== 'off').length} total={mcpGroups.length}
            onChange={mode => onChange({ ...value, mcp: { ...value.mcp, mode } })}>
            <div className="ui-capability-list">
            {mcpGroups.map(group => <CapabilitySection key={group.id} label={group.name}
              title={<><Plug className="ui-muted" size={UI_ICON_SIZE_MEDIUM} aria-hidden="true" /><span>{group.name}</span></>}
              customCount={group.selection.tools.length} total={group.tools.length}
              mode={group.selection.mode === 'selected' ? 'custom' : group.selection.mode} expandable disabled={disabled || overallMcpMode !== 'custom'}
              reason={group.unavailable ? t('capabilities.inactive') : undefined}
              onChange={mode => onChange(setMcpServerMode(value, group.id, mode === 'custom' ? 'selected' : mode))}>
              <fieldset className="ui-capability-list ui-capability-tools ui-grid-auto ui-resource-grid" disabled={overallMcpMode !== 'custom' || group.selection.mode !== 'selected'}>
                {!group.tools.length && <small>{t('capabilities.no_known_mcp_tools')}</small>}
                {group.tools.map(tool => <CheckboxField key={tool.name} aria-label={`${group.name} ${tool.name}`}
                  label={<span className="ui-row"><code className="ui-tool-name">{tool.name}</code>{tool.unavailable && <span className="ui-badge">{t('capabilities.inactive')}</span>}</span>}
                  disabled={disabled || (!tool.known && !group.selection.tools.includes(tool.name))} checked={group.selection.mode === 'all' || (group.selection.mode === 'selected' && group.selection.tools.includes(tool.name))}
                  onChange={checked => onChange(setMcpToolSelection(value, group.id, tool.name, checked))} />)}
              </fieldset>
          </CapabilitySection>)}
          </div>
          </CapabilitySection>
        </div>}
        <PluginCapabilitySelection plugins={plugins} error={pluginsError} value={value} skills={skills} subagent={subagent} disabled={disabled} onChange={onChange} />
        <SubagentSelectionEditor value={value.subagents} definitions={subagents} disabled={disabled}
          onChange={(subagents) => onChange({ ...value, subagents })} />
        <div className="ui-form-section ui-form-section-divided">
          <CapabilitySection label={t('settings.capability_skills')} customCount={[...skillIds].filter(isSkillSelected).length} total={skillIds.size}
            countSuffix={projectSkillsSelected && <> + {t('settings.skill_group_project')}</>}
            mode={value.skills.mode === 'default' ? 'all' : value.skills.mode} disabled={disabled} expandable={Boolean(projectSkills)}
            reason={skillWarning ? t('settings.subagent_skills_require_file_read') : undefined}
            onChange={mode => onChange({ ...value, skills: { ...value.skills, mode: mode === 'all' ? 'default' : mode } })}>
          <div className="ui-capability-editor">
            {(projectSkills || value.skills.mode === 'custom') && <>
              <div className="ui-capability-list">
                {skillSourceGroups((skills?.roots ?? []).filter(root => root.kind !== 'plugin'), t).map((group) => {
                  if (projectSkills && group.id === 'project') return null
                  if (subagent && group.id === 'project') return <CheckboxField key={group.id}
                      checked={value.skills.project}
                      label={<span className="ui-row"><Folder size={UI_ICON_SIZE_MEDIUM} aria-hidden="true" /><span>{t('capabilities.project_skills')}</span></span>}
                      aria-label={t('capabilities.project_skills')}
                      tooltip={t('capabilities.project_skills_hint')}
                      onChange={(project) => onChange({ ...value, skills: { ...value.skills, project } })}
                    />
                  const rootIds = new Set(group.roots.map((root) => root.id))
                  const items = (skills?.skills ?? []).filter((skill) => rootIds.has(skill.rootId))
                  if (!items.length) return null
                  const roots = group.roots.map(root => ({ root, items: items.filter(skill => skill.rootId === root.id) })).filter(entry => entry.items.length)
                  return <CapabilityResourceGroup key={group.id} label={group.label} count={`${items.filter(skill => isSkillSelected(skill.id)).length}/${items.length}`}>
                    {roots.map(({ root, items: rootItems }) => {
                      const content = <div className={subagent || root.kind === 'subagent' ? 'ui-grid-auto ui-resource-grid' : 'ui-form-section'}>
                        {rootItems.map((skill) => renderSkill({ ...skill, unavailable: Boolean(skill.loadError) }))}
                      </div>
                      return roots.length > 1
                        ? <CapabilityResourceGroup key={root.id} label={root.name} tooltip={root.path} count={rootItems.length}>{content}</CapabilityResourceGroup>
                        : <div key={root.id}>{content}</div>
                    })}
                  </CapabilityResourceGroup>
                })}
                {missingSkills.length > 0 && <CapabilityResourceGroup label={t('capabilities.other_skills')} count={missingSkills.length}>
                  <div className={subagent ? 'ui-grid-auto ui-resource-grid' : 'ui-form-section'}>{missingSkills.map(renderSkill)}</div>
                </CapabilityResourceGroup>}
                {!skills && <small>{t('capabilities.loading')}</small>}
                {projectSkills && <ProjectSkillGroup skills={skills} disabled={disabled || projectSkills.disabled}
                  onAddDirectories={projectSkills.onAddDirectories} onRemoveDirectory={projectSkills.onRemoveDirectory}
                  renderSkill={skill => renderSkill({ ...skill, unavailable: Boolean(skill.loadError) })} />}
              </div>
            </>}
          </div>
          </CapabilitySection>
        </div>
        {ownResources && <SubagentPackagePanel resources={ownResources} value={value} onChange={onChange} />}
      </div>
    </fieldset>
  )
}

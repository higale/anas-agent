import { useTranslation } from 'react-i18next'
import { resolveToolSelection, withToolShadows, type ToolPackage, type ToolRoot, type ToolSelection } from '@shared/toolPackages'
import { CapabilitySection } from './CapabilitySection'
import { CapabilityResourceGroup } from './CapabilityResourceGroup'
import { CapabilityResourceRow, CapabilityResourceToggle } from './CapabilityResource'

export function CustomToolSelectionEditor({ value, tools, roots = [], subagent = false, backgroundTools, disabled, onChange }: {
  value: ToolSelection; tools: readonly ToolPackage[]; roots?: readonly ToolRoot[]; subagent?: boolean
  backgroundTools: boolean; disabled?: boolean; onChange(value: ToolSelection): void
}) {
  const { t } = useTranslation()
  const mode = value.mode ?? 'custom'
  const selectionDisabled = disabled || mode !== 'custom'
  const visible = tools.filter(tool => !subagent || tool.source !== 'project')
  const effective = resolveToolSelection(value, visible.filter(tool => backgroundTools || !tool.definition?.interactive), subagent, false).entries
  const items = withToolShadows(visible, effective)
  const selected = (id: string) => mode === 'all' || (mode === 'custom' && value.entries.includes(id))
  const missing = value.entries.filter(id => !tools.some(tool => tool.id === id))
  const rootMap = new Map<string, Pick<ToolRoot, 'id' | 'name' | 'source'> & Partial<ToolRoot>>()
  for (const root of roots) if (!subagent || root.source !== 'project') rootMap.set(root.id, root)
  for (const tool of items) if (!rootMap.has(tool.rootId)) rootMap.set(tool.rootId, { id: tool.rootId, name: tool.rootName, source: tool.source })
  const activeRoots = [...rootMap.values()].filter(root => items.some(tool => tool.rootId === root.id)
    || (root.error && (root.source !== 'project' || root.error.code !== 'path_not_found')))
  const groups = [
    { id: 'user', label: t('settings.skill_group_user'), roots: activeRoots.filter(root => root.source === 'user') },
    ...activeRoots.filter(root => root.source === 'external' || root.source === 'subagent').map(root => ({ id: root.id, label: root.name, roots: [root] })),
    { id: 'project', label: t('settings.skill_group_project'), roots: activeRoots.filter(root => root.source === 'project') }
  ].filter(group => group.roots.length)
  function setSelected(id: string, enabled: boolean) {
    const retained = value.entries.filter(entry => entry !== id)
    onChange({ ...value, entries: enabled ? [...retained, id] : retained })
  }
  function renderTool(tool: ToolPackage) {
    const unavailable = tool.enabled === false || Boolean(tool.error)
    const requiresBackground = tool.definition?.interactive && !backgroundTools
    return <CapabilityResourceRow key={tool.id} name={tool.name} description={tool.description} directory={tool.directory}
      status={<>
        {unavailable && <span className="ui-badge">{t('capabilities.inactive')}</span>}
        {tool.shadowedBy && <span className="ui-badge" data-tooltip={t('custom_tools.shadowed_by', { source: tool.shadowedBy })}>{t('custom_tools.shadowed')}</span>}
        {requiresBackground && <span className="ui-badge">{t('custom_tools.requires_background')}</span>}
      </>}
      controls={<CapabilityResourceToggle label={`${tool.rootName} ${tool.name}`} enabled={selected(tool.id)}
        disabled={selectionDisabled || (!tool.definition && !value.entries.includes(tool.id))} onChange={enabled => setSelected(tool.id, enabled)} />}>
      {tool.error && <span role="alert" className="ui-field-hint ui-status-danger">{t(`custom_tools.load_error_${tool.error.code}`)}</span>}
    </CapabilityResourceRow>
  }
  function renderGroup(group: typeof groups[number]) {
    const members = items.filter(tool => group.roots.some(root => root.id === tool.rootId))
    return <CapabilityResourceGroup key={group.id} label={group.label} fullWidthDivider={group.id === 'project'}
      ariaLabel={group.id === 'project' ? t('project.local_tools') : group.label} count={`${members.filter(tool => selected(tool.id)).length}/${members.length}`}>
      {group.roots.map(root => {
        const rootItems = items.filter(tool => tool.rootId === root.id)
        const content = <>
          {root.error && <span role="alert" className="ui-field-hint ui-status-danger">{root.path}: {t(`custom_tools.load_error_${root.error.code}`)}</span>}
          {rootItems.map(renderTool)}
        </>
        return group.roots.length > 1
          ? <CapabilityResourceGroup key={root.id} label={root.name} ariaLabel={root.path ?? root.id} tooltip={root.path} count={rootItems.length}>{content}</CapabilityResourceGroup>
          : <div key={root.id} className="ui-form-section">{content}</div>
      })}
    </CapabilityResourceGroup>
  }
  return <CapabilitySection label={t('custom_tools.title')} customCount={items.filter(tool => value.entries.includes(tool.id)).length + missing.length}
    total={items.length + missing.length} mode={mode} disabled={disabled} expandable
    countSuffix={subagent && mode === 'custom' && value.project && <> + {t('custom_tools.project_tools_summary')}</>}
    onChange={mode => onChange({ ...value, mode })}>
    <div className="ui-capability-list">
      {subagent && <CapabilityResourceRow name={t('custom_tools.project_tools')}
        controls={<CapabilityResourceToggle label={t('custom_tools.project_tools')} enabled={mode === 'all' || (mode === 'custom' && value.project)}
          disabled={selectionDisabled} onChange={project => onChange({ ...value, project })} />} />}
      {groups.filter(group => group.id !== 'project').map(renderGroup)}
      {missing.length > 0 && <CapabilityResourceGroup label={t('capabilities.other_tools')} count={missing.length}>
        {missing.map(id => <CapabilityResourceRow key={id} name={id} status={<span className="ui-badge">{t('capabilities.deleted')}</span>}
          controls={<CapabilityResourceToggle label={id} enabled={selected(id)} disabled={selectionDisabled} onChange={enabled => setSelected(id, enabled)} />} />)}
      </CapabilityResourceGroup>}
      {groups.filter(group => group.id === 'project').map(renderGroup)}
      {!groups.length && !missing.length && <small>{t('custom_tools.empty')}</small>}
    </div>
  </CapabilitySection>
}

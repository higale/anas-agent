import { ProjectDirectoryAddButton, ProjectResourceGroup, type ProjectDirectoryControls } from './projects/ProjectResourceGroup'
import { customToolCapabilityIssue } from '@shared/customTools'
import { useTranslation } from 'react-i18next'
import { resolveToolSelection, withToolShadows, type ToolPackage, type ToolRoot, type ToolSelection } from '@shared/toolPackages'
import { CapabilitySection } from './CapabilitySection'
import { CapabilityResourceGroup } from './CapabilityResourceGroup'
import { CapabilityResourceRow } from './CapabilityResource'

export function CustomToolSelectionEditor({ value, tools, roots = [], subagent = false, backgroundTools, disabled, projectTools, onChange }: {
  value: ToolSelection; tools: readonly ToolPackage[]; roots?: readonly ToolRoot[]; subagent?: boolean
  projectTools?: ProjectDirectoryControls
  backgroundTools: boolean; disabled?: boolean; onChange(value: ToolSelection): void
}) {
  const { t } = useTranslation()
  const mode = value.mode ?? 'custom'
  const selectionDisabled = disabled
  const visible = tools.filter(tool => !subagent || tool.source !== 'project')
  const effective = resolveToolSelection(value, visible.filter(tool => !customToolCapabilityIssue(tool.definition, backgroundTools)), subagent, false).entries
  const items = withToolShadows(visible, effective)
  const selected = (id: string) => mode === 'all' || (mode === 'custom' && value.entries.includes(id))
  const missing = value.entries.filter(id => !tools.some(tool => tool.id === id))
  const rootMap = new Map<string, Pick<ToolRoot, 'id' | 'name' | 'source'> & Partial<ToolRoot>>()
  for (const root of roots) if (!subagent || root.source !== 'project') rootMap.set(root.id, root)
  for (const tool of items) if (!rootMap.has(tool.rootId)) rootMap.set(tool.rootId, { id: tool.rootId, name: tool.rootName, source: tool.source })
  const activeRoots = [...rootMap.values()].filter(root => items.some(tool => tool.rootId === root.id)
    || (root.error && (root.source !== 'project' || root.error.code !== 'path_not_found')))
  const groups = [
    { id: 'system', label: t('settings.skill_group_system'), roots: activeRoots.filter(root => root.source === 'system') },
    { id: 'user', label: t('settings.skill_group_user'), roots: activeRoots.filter(root => root.source === 'user') },
    ...activeRoots.filter(root => root.source === 'external' || root.source === 'subagent').map(root => ({ id: root.id, label: root.name, roots: [root] })),
    { id: 'project', label: t('settings.skill_group_project'), roots: activeRoots.filter(root => root.source === 'project') }
  ].filter(group => group.roots.length)
  function setSelected(id: string, enabled: boolean) {
    setSelections([id], enabled)
  }
  function setSelections(ids: readonly string[], enabled: boolean, project = mode === 'all' || (mode === 'custom' && value.project)) {
    const targets = new Set(ids)
    const retained = [...new Set([...tools.map(tool => tool.id), ...value.entries])].filter(entry => !targets.has(entry) && selected(entry))
    onChange({ ...value, mode: 'custom', project, entries: enabled ? [...retained, ...targets] : retained })
  }
  const isGroupSelected = (members: readonly ToolPackage[]) => members.every(tool => !tool.definition || selected(tool.id))
  function setGroupSelected(members: readonly ToolPackage[], enabled: boolean) {
    setSelections(members.filter(tool => !enabled || tool.definition || selected(tool.id)).map(tool => tool.id), enabled)
  }
  const bulkItems = items.filter(tool => !(tool.source === 'project' && projectTools?.disabled))
  function setMainGroupSelected(checked: boolean) {
    const ids = [...bulkItems.filter(tool => !checked || tool.definition || selected(tool.id)).map(tool => tool.id), ...missing]
    setSelections(ids, checked, subagent ? checked : value.project)
  }
  function renderTool(tool: ToolPackage) {
    const capabilityIssue = customToolCapabilityIssue(tool.definition, backgroundTools)
    const inactiveReason = [tool.enabled === false && t('capabilities.globally_disabled'),
      tool.error && [t(`custom_tools.load_error_${tool.error.code}`), tool.error.detail].filter(Boolean).join('\n'),
      tool.shadowedBy && t('custom_tools.shadowed_by', { source: tool.shadowedBy }),
      capabilityIssue && t(capabilityIssue)].filter(Boolean).join('\n')
    return <CapabilityResourceRow key={tool.id} name={tool.name} description={tool.description} directory={tool.directory}
      inactiveReason={inactiveReason}
      label={`${tool.rootName} ${tool.name}`} enabled={selected(tool.id)}
        disabled={selectionDisabled || (!tool.definition && !selected(tool.id))} onChange={enabled => setSelected(tool.id, enabled)} />
  }
  function renderGroup(group: typeof groups[number]) {
    const members = items.filter(tool => group.roots.some(root => root.id === tool.rootId))
    const rootError = (root: typeof group.roots[number]) => root.error
      ? [root.path, t(`custom_tools.load_error_${root.error.code}`), root.error.detail].filter(Boolean).join('\n') : undefined
    return <CapabilityResourceGroup key={group.id} label={group.label} divider={group.id === 'project'}
      allSelected={isGroupSelected(members)} onSelectionChange={mode === 'custom' ? checked => setGroupSelected(members, checked) : undefined}
      selectionDisabled={selectionDisabled || !members.length}
      inactiveReason={group.roots.length === 1 ? rootError(group.roots[0]) : undefined}
      ariaLabel={group.id === 'project' ? t('project.local_tools') : group.label} count={`${members.filter(tool => selected(tool.id)).length}/${members.length}`}>
      {group.roots.map(root => {
        const rootItems = items.filter(tool => tool.rootId === root.id)
        const content = <>
          <div className="ui-grid-auto">{rootItems.map(renderTool)}</div>
        </>
        return group.roots.length > 1
          ? <CapabilityResourceGroup key={root.id} label={root.name} ariaLabel={root.path ?? root.id} tooltip={root.path} inactiveReason={rootError(root)} count={rootItems.length}
            allSelected={isGroupSelected(rootItems)} onSelectionChange={mode === 'custom' ? checked => setGroupSelected(rootItems, checked) : undefined}
            selectionDisabled={selectionDisabled || !rootItems.length}>{content}</CapabilityResourceGroup>
          : <div key={root.id} className="ui-form-section">{content}</div>
      })}
    </CapabilityResourceGroup>
  }
  return <div className="ui-form-section ui-form-section-divided">
    <CapabilitySection label={t('custom_tools.title')} selected={[...items.map(tool => tool.id), ...missing].filter(selected).length}
      selectionDisabled={!bulkItems.length && !missing.length && !subagent}
      allSelected={isGroupSelected(bulkItems) && (!subagent || value.project)} onSelectionChange={setMainGroupSelected}
      mode={mode} disabled={disabled} onChange={mode => onChange({ ...value, mode })}
      actions={projectTools && <ProjectDirectoryAddButton kind="tool" onAddDirectories={projectTools.onAddDirectories} disabled={disabled || projectTools.disabled} />}
      total={items.length + missing.length}
      countSuffix={subagent && (mode === 'all' || (mode === 'custom' && value.project)) && <> + {t('custom_tools.project_tools_summary')}</>}>
      <div className="ui-capability-list">
        {subagent && <CapabilityResourceRow name={t('custom_tools.project_tools')}
          label={t('custom_tools.project_tools')} enabled={mode === 'all' || (mode === 'custom' && value.project)}
            disabled={selectionDisabled} onChange={project => onChange({ ...value, mode: 'custom', entries: [...new Set([...tools.map(tool => tool.id), ...value.entries])].filter(selected), project })} />}
        {groups.filter(group => group.id !== 'project').map(renderGroup)}
        {missing.length > 0 && <CapabilityResourceGroup label={t('capabilities.other_tools')} count={missing.length} allSelected={missing.every(selected)}
          onSelectionChange={mode === 'custom' ? checked => setSelections(checked ? missing.filter(selected) : missing, checked) : undefined}
          selectionDisabled={selectionDisabled}>
          <div className="ui-grid-auto">{missing.map(id => <CapabilityResourceRow key={id} name={id} inactiveReason={t('capabilities.deleted')}
            label={id} enabled={selected(id)} disabled={selectionDisabled} onChange={enabled => setSelected(id, enabled)} />)}</div>
        </CapabilityResourceGroup>}
        {projectTools ? <ProjectResourceGroup kind="tool" {...projectTools} disabled={disabled || projectTools.disabled}
          isAllSelected={isGroupSelected} onSelectionChange={mode === 'custom' ? setGroupSelected : undefined}
          roots={roots.filter(root => root.source === 'project').map(root => ({ ...root, available: !root.error,
            error: root.error ? t(`custom_tools.load_error_${root.error.code}`) : undefined
          }))} items={items.filter(tool => tool.source === 'project')} renderItem={renderTool} />
          : groups.filter(group => group.id === 'project').map(renderGroup)}
        {!projectTools && !groups.length && !missing.length && <small>{t('custom_tools.empty')}</small>}
      </div>
    </CapabilitySection>
  </div>
}

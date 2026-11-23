import { pluginCapabilityEnabled, type PluginCapabilityKind } from '@shared/pluginCapabilities'
import { CapabilityPreviewItem } from './CapabilityPreviewItem'
import { CapabilityGroupActions } from '../CapabilityGroupActions'
import { notice } from '../notice'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PluginPromptPreview, PluginSummary } from '@shared/plugins'
import { pluginToolName } from '@shared/pluginTools'
import { errorDetail } from '@shared/recovery'
import { ContentPreviewDialog } from './ContentPreviewDialog'
import { PackageMarkdownPreview } from './PackageTree'
import { SegmentedControl } from '../SegmentedControl'
import { SegmentedMultiSelect } from '../SegmentedMultiSelect'
import type { SkillAvailabilityUpdate, SkillSnapshot } from '@shared/types'
import { CheckboxField } from '../CheckboxField'

function PromptDetails({ plugin, id, onClose }: { plugin: PluginSummary; id: string; onClose(): void }) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<PluginPromptPreview>()
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const [source, setSource] = useState(false)
  const manifest = plugin.manifest!
  const prompt = manifest.prompts!.find(item => item.id === id)!
  useEffect(() => {
    let active = true
    setPreview(undefined)
    setError(undefined)
    void window.gale.plugins.readPrompt(plugin.id, id).then(value => {
      if (active) setPreview(value)
    }).catch(reason => { if (active) setError(errorDetail(reason)) })
    return () => { active = false }
  }, [plugin.id, manifest.pluginVersion, prompt.path, id, retry])
  return <ContentPreviewDialog title={id} description={t('plugins.preview_hint')}
    copyText={preview?.content} onClose={onClose}>
    <div className="settings-contribution-preview ui-form-section">
      <dl className="settings-contribution-metadata">
        <dt>{t('plugins.declaration_id')}</dt><dd><code>{id}</code></dd>
        <dt>{t('plugins.file_path')}</dt><dd><code>{prompt.path}</code></dd>
        <dt>{t('plugins.prompt_scope')}</dt><dd>{t(`plugins.scope_${prompt.scope}`)}</dd>
        {Boolean(prompt.tools.length) && <><dt>{t('plugins.required_tools')}</dt><dd>{prompt.tools.map(localId =>
          <code key={localId}>{pluginToolName(plugin.id, localId)}</code>)}</dd></>}
      </dl>
      {prompt.description && <p className="ui-field-hint">{prompt.description}</p>}
      {error ? <div className="ui-note ui-note-danger" role="alert">
        <p>{t('plugins.preview_failed')}</p><p>{error}</p>
        <button type="button" className="ui-button" onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</button>
      </div> : preview ? <>
        <div className="ui-toolbar"><SegmentedControl ariaLabel={t('settings.file_view_mode')} value={source ? 'source' : 'preview'}
          options={[{ value: 'preview', label: t('settings.file_preview') }, { value: 'source', label: t('settings.file_source') }]}
          onChange={value => setSource(value === 'source')} /></div>
        {source ? <pre className="ui-code-block settings-code-preview-code">{preview.content}</pre> : <PackageMarkdownPreview preview={preview} t={t} />}
      </> : <div role="status" className="ui-field-hint">{t('common.loading')}</div>}
    </div>
  </ContentPreviewDialog>
}

export function PluginContributions({ plugin, busy, skills, onUpdateSkillAvailability, onRefresh }: {
  plugin: PluginSummary
  busy?: boolean
  skills?: SkillSnapshot
  onUpdateSkillAvailability(skillIds: string | string[], update: SkillAvailabilityUpdate): void | Promise<void>
  onRefresh(): Promise<void>
}) {
  const { t } = useTranslation()
  const [selectedPrompt, setSelectedPrompt] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [choices, setChoices] = useState(plugin.capabilityChoices)
  const pending = useRef(false)
  useEffect(() => {
    if (!pending.current) setChoices(plugin.capabilityChoices)
  }, [plugin.capabilityChoices])
  const enabled = (kind: PluginCapabilityKind, id: string) => pluginCapabilityEnabled(choices, kind, id)
  async function save(kind: PluginCapabilityKind, ids: string[], checked: boolean) {
    if (pending.current) return
    pending.current = true
    const previous = choices
    setChoices({ ...choices, [kind]: { ...choices?.[kind], ...Object.fromEntries(ids.map(id => [id, checked])) } })
    setSaving(true)
    let saved = false
    try {
      const next = await window.gale.plugins.setCapabilityEnabled(plugin.id, kind, ids, checked)
      saved = true
      setChoices(next)
      await onRefresh()
    } catch (reason) {
      if (!saved) setChoices(previous)
      notice.error(t('plugins.operation_failed'), { description: errorDetail(reason) })
    } finally { pending.current = false; setSaving(false) }
  }
  const manifest = plugin.manifest
  if (!manifest) return null
  const groups = [
    { kind: 'prompt', label: t('plugins.prompts'), items: (manifest.prompts ?? []).map(item => ({ ...item, name: item.id })) },
    { kind: 'skill', label: t('settings.skills'), items: (manifest.skills ?? []).map(item => {
      const summary = plugin.skillSummaries?.find(summary => summary.id === item.id)
      return { id: item.id, tools: item.tools, name: summary?.name ?? item.id, description: summary?.description ?? '' }
    }) },
    { kind: 'tool', label: t('plugins.tools'), items: manifest.tools.map(item => ({ ...item, name: item.id })) }
  ] as const
  const selectedPromptExists = selectedPrompt && manifest.prompts?.some(item => item.id === selectedPrompt)
  return <>
    {groups.filter(group => group.items.length).map(group => {
      if (group.kind === 'skill') {
        const items = group.items.map(item => {
          const skillId = `${plugin.id}:skill:${item.id}`
          const skill = skills?.skills.find(skill => skill.id === skillId)
          return { ...item, skillId, availability: skill?.configuredAvailability ?? skill }
        })
        return <details open className="settings-contribution-group ui-form-section-divided" key={group.kind} aria-label={group.label}>
        <summary><span className="settings-contribution-heading"><strong>{group.label}</strong><small>{items.length}</small>
          <CapabilityGroupActions allSelected={items.every(({ availability }) => availability?.userAvailable && availability.modelAvailable)}
            disabled={busy || Boolean(plugin.error) || items.some(item => !item.availability)}
            onChange={checked => void onUpdateSkillAvailability(items.map(item => item.skillId), { userAvailable: checked, modelAvailable: checked })} />
        </span></summary>
        <div className="ui-form-section">
          {items.map(item => {
            const { skillId, availability } = item
            const missing = item.tools.filter(id => !enabled('tool', id))
            const reason = !plugin.enabled ? t('plugins.disabled')
              : missing.length ? t('plugins.missing_tools_detail', { tools: missing.map(id => pluginToolName(plugin.id, id)).join(', ') }) : undefined
            return <div key={item.id} className="ui-form-row ui-form-row-fit-control">
              <code className={`settings-tool-catalog-name ui-tool-name${reason ? ' ui-resource-unavailable' : ''}`}
                data-tooltip={[reason, item.description].filter(Boolean).join('\n') || undefined}>{item.name}</code>
              <SegmentedMultiSelect<'userAvailable' | 'modelAvailable'> ariaLabel={item.name}
                disabled={busy || Boolean(plugin.error) || !availability}
                options={[
                  { value: 'userAvailable', label: t('settings.skill_user_available'), checked: availability?.userAvailable ?? false },
                  { value: 'modelAvailable', label: t('settings.skill_model_available'), checked: availability?.modelAvailable ?? false }
                ]}
                onChange={(field, checked) => void onUpdateSkillAvailability(skillId, { [field]: checked })} />
            </div>
          })}
        </div>
      </details>
      }
      return <details open className="settings-contribution-group ui-form-section-divided" key={group.kind} aria-label={group.label}>
        <summary><span className="settings-contribution-heading"><strong>{group.label}</strong><small>{group.items.filter(item => enabled(group.kind, item.id)).length}/{group.items.length}</small>
          <CapabilityGroupActions allSelected={group.items.every(item => enabled(group.kind, item.id))} disabled={busy || Boolean(plugin.error)}
            busy={saving} onChange={checked => void save(group.kind, group.items.map(item => item.id), checked)} />
        </span></summary>
      <div className="settings-tool-catalog">
        {group.items.map(item => {
          const missing = ('tools' in item ? item.tools : []).filter(id => !enabled('tool', id))
          const reason = missing.length ? t('plugins.missing_tools_detail', { tools: missing.map(id => pluginToolName(plugin.id, id)).join(', ') }) : undefined
          if (group.kind === 'tool') return <CheckboxField key={item.id} aria-label={item.name}
            label={<code className="ui-tool-name">{item.name}</code>} tooltip={item.description}
            checked={enabled('tool', item.id)} disabled={busy || Boolean(plugin.error)}
            aria-disabled={saving || undefined} aria-busy={saving || undefined}
            onChange={checked => void save('tool', [item.id], checked)} />
          return <CapabilityPreviewItem key={item.id} name={item.name} checked={enabled(group.kind, item.id)}
            disabled={busy || Boolean(plugin.error)} busy={saving} description={item.description} inactiveReason={reason}
            onChange={checked => void save(group.kind, [item.id], checked)}
            onPreview={() => setSelectedPrompt(item.id)} />
        })}
      </div>
    </details>})}
    {selectedPromptExists && <PromptDetails key={selectedPrompt} plugin={plugin} id={selectedPrompt} onClose={() => setSelectedPrompt(undefined)} />}
  </>
}

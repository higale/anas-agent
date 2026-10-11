import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PluginContributionKind, PluginContributionPreview, PluginSummary } from '@shared/plugins'
import { pluginToolName } from '@shared/pluginTools'
import { errorDetail } from '@shared/recovery'
import { ContentPreviewDialog } from './ContentPreviewDialog'
import { PackageMarkdownPreview } from './PackageTree'
import { SegmentedControl } from '../SegmentedControl'

type Selection = { kind: PluginContributionKind | 'tool'; id: string }

function ContributionDetails({ plugin, selection, onClose }: { plugin: PluginSummary; selection: Selection; onClose(): void }) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<PluginContributionPreview>()
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const [source, setSource] = useState(false)
  const { kind, id } = selection
  const manifest = plugin.manifest!
  const tool = kind === 'tool' ? manifest.tools.find(item => item.id === id) : undefined
  const prompt = kind === 'prompt' ? manifest.prompts?.find(item => item.id === id) : undefined
  const skill = kind === 'skill' ? manifest.skills?.find(item => item.id === id) : undefined
  const summary = plugin.skillSummaries?.find(item => item.id === id)
  const declaration = prompt ?? skill
  const title = tool ? pluginToolName(plugin.id, tool.id) : skill ? summary?.name ?? id : id
  const toolText = tool ? JSON.stringify({ name: title, description: tool.description, parameters: tool.inputSchema }, null, 2) : undefined
  useEffect(() => {
    if (kind === 'tool') return
    let active = true
    setPreview(undefined)
    setError(undefined)
    void window.gale.plugins.readContribution(plugin.id, kind, id).then(value => {
      if (active) setPreview(value)
    }).catch(reason => { if (active) setError(errorDetail(reason)) })
    return () => { active = false }
  }, [plugin.id, manifest.pluginVersion, declaration?.path, kind, id, retry])
  return <ContentPreviewDialog title={title} description={t('plugins.preview_hint')}
    copyText={toolText ?? preview?.content} onClose={onClose}>
    <div className="settings-contribution-preview ui-form-section">
      <dl className="settings-contribution-metadata">
        {declaration && <><dt>{t('plugins.declaration_id')}</dt><dd><code>{id}</code></dd>
          <dt>{t('plugins.file_path')}</dt><dd><code>{declaration.path}</code></dd></>}
        {prompt && <><dt>{t('plugins.prompt_scope')}</dt><dd>{t(`plugins.scope_${prompt.scope}`)}</dd></>}
        {Boolean(declaration?.tools.length) && <><dt>{t('plugins.required_tools')}</dt><dd>{declaration!.tools.map(localId =>
          <code key={localId}>{pluginToolName(plugin.id, localId)}</code>)}</dd></>}
        {tool && <><dt>{t('plugins.tool_effect')}</dt><dd>{t(`plugins.effect_${tool.effect}`)} <code>({tool.effect})</code></dd>
          <dt>{t('custom_tools.timeout')}</dt><dd>{tool.timeoutSeconds}</dd></>}
      </dl>
      {toolText ? <pre className="ui-code-block settings-code-preview-code">{toolText}</pre> : <>
        {(prompt?.description || summary?.description) && <p className="ui-field-hint">{prompt?.description ?? summary?.description}</p>}
        {error ? <div className="ui-note ui-note-danger" role="alert">
          <p>{t('plugins.preview_failed')}</p><p>{error}</p>
          <button type="button" className="ui-button" onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</button>
        </div> : preview ? <>
          <div className="ui-toolbar"><SegmentedControl ariaLabel={t('settings.file_view_mode')} value={source ? 'source' : 'preview'}
            options={[{ value: 'preview', label: t('settings.file_preview') }, { value: 'source', label: t('settings.file_source') }]}
            onChange={value => setSource(value === 'source')} /></div>
          {source ? <pre className="ui-code-block settings-code-preview-code">{preview.content}</pre> : <PackageMarkdownPreview preview={preview} t={t} />}
        </> : <div role="status" className="ui-field-hint">{t('common.loading')}</div>}
      </>}
    </div>
  </ContentPreviewDialog>
}

export function PluginContributions({ plugin }: { plugin: PluginSummary }) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Selection>()
  const manifest = plugin.manifest
  if (!manifest) return null
  const groups = [
    { kind: 'prompt', label: t('plugins.prompts'), items: (manifest.prompts ?? []).map(item => ({ ...item, name: item.id })) },
    { kind: 'skill', label: t('settings.skills'), items: (manifest.skills ?? []).map(item => {
      const summary = plugin.skillSummaries?.find(summary => summary.id === item.id)
      return { id: item.id, name: summary?.name ?? item.id, description: summary?.description ?? '' }
    }) },
    { kind: 'tool', label: t('plugins.tools'), items: manifest.tools.map(item => ({ ...item, name: pluginToolName(plugin.id, item.id) })) }
  ] as const
  const selectionExists = selected && groups.some(group => group.kind === selected.kind && group.items.some(item => item.id === selected.id))
  return <>
    {groups.filter(group => group.items.length).map(group => <details open className="settings-contribution-group ui-form-section-divided" key={group.kind}>
      <summary><strong>{group.label}</strong><small>{group.items.length}</small></summary>
      <div className="settings-tool-catalog">
        {group.items.map(item => <button key={item.id} type="button" className="settings-tool-catalog-row"
          data-tooltip={item.description || undefined} onClick={() => setSelected({ kind: group.kind, id: item.id })}>
          <code className="settings-tool-catalog-name ui-tool-name">{item.name}</code>
        </button>)}
      </div>
    </details>)}
    {selectionExists && <ContributionDetails key={`${selected.kind}:${selected.id}`} plugin={plugin} selection={selected} onClose={() => setSelected(undefined)} />}
  </>
}

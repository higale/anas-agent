import { errorDetail } from '@shared/recovery'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Code, Pencil, Plus, Settings2, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CheckboxField } from '../CheckboxField'
import { CommitNumberInput } from '../CommitNumberInput'
import { CommitTextarea } from '../CommitTextField'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { SegmentedControl } from '../SegmentedControl'
import { notice } from '../notice'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { canEditParameter, changeParameter, isSchemaObject, parameterType, parameterTypes, removeParameter, replaceSchema, schemaAt, type SchemaObject, type SchemaPath } from './toolParameterSchema'

type EditTarget = { path: SchemaPath; parent?: SchemaPath; name?: string; adding?: boolean }
const numericConstraints: Record<string, string[]> = {
  string: ['minLength', 'maxLength'], number: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  integer: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  array: ['minItems', 'maxItems'], object: ['minProperties', 'maxProperties']
}
const numericKeywords = [...new Set(Object.values(numericConstraints).flat())]
const displayedKeywords = new Set(['type', 'description'])

export function ToolParameters({ value, onChange, onBusyChange, onEditingChange, onDirtyChange, onEdit, disabled }: {
  value: string; onChange?(value: string): void; onBusyChange?(busy: boolean): void; disabled?: boolean
  onEditingChange?(editing: boolean): void; onDirtyChange?(dirty: boolean): void; onEdit?(): void
}) {
  const { t } = useTranslation()
  const [mode, setMode] = useState('parameters')
  const [editing, setEditing] = useState<EditTarget>()
  const [busy, setBusy] = useState(false)
  function setPending(pending: boolean) { setBusy(pending); onBusyChange?.(pending) }
  function edit(target?: EditTarget) {
    setEditing(target); onEditingChange?.(Boolean(target)); onDirtyChange?.(false)
  }
  const parsed = useMemo(() => {
    try {
      const schema: unknown = JSON.parse(value)
      if (!isSchemaObject(schema) || schema.type !== 'object') return { error: 'custom_tools.parameter_invalid_root' }
      return { schema }
    }
    catch { return { error: 'custom_tools.parameter_invalid_json' } }
  }, [value])
  const schema = parsed.schema
  function report(reason: unknown) {
    const message = errorDetail(reason)
    notice.error(message.startsWith('custom_tools.') ? t(message) : message, { id: 'tool-parameter-error' })
  }
  async function commit(next: SchemaObject) {
    await window.gale.tools.validateSchema(next)
    onChange?.(JSON.stringify(next, null, 2))
  }
  async function remove(parent: SchemaPath, name: string) {
    if (!schema) return
    setPending(true)
    try { await commit(removeParameter(schema, parent, name)) } catch (reason) { report(reason) }
    finally { setPending(false) }
  }
  async function switchMode(next: string) {
    if (next === 'source') { setMode(next); return }
    if (parsed.error) { report(parsed.error); return }
    setPending(true)
    try { if (onChange) await window.gale.tools.validateSchema(schema); setMode(next) }
    catch (reason) { report(reason) }
    finally { setPending(false) }
  }
  return <><div hidden={Boolean(editing)}><fieldset className="ui-form-section tool-parameters" aria-label={t('custom_tools.parameter_form')} disabled={busy || disabled}>
    <div className="ui-toolbar ui-toolbar-between">
      <strong>{t('custom_tools.schema')}</strong>
      <div className="ui-row">
        {onEdit && <button className="ui-icon-button" type="button" aria-label={t('custom_tools.edit_parameters')}
          data-tooltip={t('custom_tools.edit_parameters')} onClick={onEdit}><Pencil size={14} /></button>}
        {onChange && schema && mode === 'parameters' && <>
          <button className="ui-icon-button" type="button" aria-label={t('custom_tools.parameter_root')} data-tooltip={t('custom_tools.parameter_root')}
            onClick={() => canEditParameter(schema) ? edit({ path: [] }) : setMode('source')}><Settings2 size={14} /></button>
          <button className="ui-icon-button" type="button" aria-label={t('custom_tools.parameter_add')} data-tooltip={t('custom_tools.parameter_add')}
            onClick={() => edit({ path: [], parent: [], adding: true })}><Plus size={14} /></button>
        </>}
        <SegmentedControl ariaLabel={t('custom_tools.parameter_mode')} value={mode}
          options={[{ value: 'parameters', label: t('custom_tools.parameter_form') }, { value: 'source', label: t('settings.file_source') }]}
          onChange={next => void switchMode(next)} />
      </div>
    </div>
    {mode === 'source' ? onChange
      ? <CommitTextarea aria-label={t('custom_tools.schema')} className="ui-textarea ui-code-textarea tool-parameter-source" rows={12} value={value} onCommit={onChange} onDraftChange={onChange} />
      : <pre className="ui-code-block tool-parameter-source">{value}</pre>
      : schema && <>
        <ParameterChildren schema={schema} path={[]} depth={0} edit={onChange ? edit : undefined} remove={remove} source={() => setMode('source')} />
        <SchemaConstraints schema={schema} />
      </>}
    {parsed.error && <p className="ui-note ui-note-danger" role="alert">{parsed.error.startsWith('custom_tools.') ? t(parsed.error) : parsed.error}</p>}
  </fieldset></div>
    {schema && editing && <ParameterEditor target={editing} schema={schema} onClose={() => edit(undefined)}
      onBusyChange={setPending} onDirtyChange={onDirtyChange} onApply={async (name, node, required) => {
        const next = editing.parent !== undefined
          ? changeParameter(schema, editing.parent, editing.adding ? undefined : editing.name, name, node, required)
          : replaceSchema(schema, editing.path, node)
        await commit(next)
        edit(undefined)
      }} />}
  </>
}

function ParameterChildren({ schema, path, depth, edit, remove, source }: {
  schema: SchemaObject; path: SchemaPath; depth: number; edit?: (target: EditTarget) => void
  remove(parent: SchemaPath, name: string): void; source(): void
}) {
  const { t } = useTranslation()
  const properties = schema.type === 'object' && isSchemaObject(schema.properties) ? Object.entries(schema.properties) : []
  return <div className="tool-parameter-list">
    {properties.map(([name, value]) => <ParameterNode key={name} name={name} value={value} path={[...path, 'properties', name]} parent={path}
      required={Array.isArray(schema.required) && schema.required.includes(name)} depth={depth} edit={edit} remove={remove} source={source} />)}
    {schema.type === 'array' && !Array.isArray(schema.items) && <ParameterNode name={t('custom_tools.parameter_items')}
      value={schema.items ?? {}} path={[...path, 'items']} depth={depth} edit={edit} remove={remove} source={source} />}
    {schema.type === 'object' && !properties.length && <p className="ui-field-hint">{t('custom_tools.parameter_empty')}</p>}
  </div>
}

function ParameterNode({ name, value, path, parent, required, depth, edit, remove, source }: {
  name: string; value: unknown; path: SchemaPath; parent?: SchemaPath; required?: boolean; depth: number
  edit?: (target: EditTarget) => void; remove(parent: SchemaPath, name: string): void; source(): void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(depth === 0)
  const type = parameterType(value)
  const object = isSchemaObject(value) ? value : undefined
  const nested = object && (type === 'object' || (type === 'array' && !Array.isArray(object.items)))
  const editable = canEditParameter(value)
  return <div className="tool-parameter-node">
    <div className="tool-parameter-heading">
      {nested && <button className="ui-tool-button ui-tool-button-small" type="button" aria-label={`${t(expanded ? 'custom_tools.collapse' : 'custom_tools.expand')} ${name}`}
        aria-expanded={expanded} onClick={() => setExpanded(current => !current)}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>}
      <code className="tool-parameter-name">{name}</code>
      <span className="tool-parameter-type">{t(`custom_tools.parameter_type_${type}`)}</span>
      {required && <span className="tool-parameter-required">{t('custom_tools.parameter_required')}</span>}
      {edit && <div className="ui-row tool-parameter-actions">
        {type === 'object' && <button className="ui-icon-button" type="button" aria-label={`${t('custom_tools.parameter_add')} ${name}`} data-tooltip={t('custom_tools.parameter_add')}
          onClick={() => { setExpanded(true); edit({ path, parent: path, adding: true }) }}><Plus size={14} /></button>}
        <button className="ui-icon-button" type="button" aria-label={`${t(editable ? 'common.edit' : 'settings.file_source')} ${name}`} data-tooltip={t(editable ? 'common.edit' : 'settings.file_source')}
          onClick={() => editable ? edit({ path, parent, name: parent !== undefined ? name : undefined }) : source()}>{editable ? <Pencil size={14} /> : <Code size={14} />}</button>
        {parent !== undefined && <button className="ui-icon-button ui-button-danger" type="button" aria-label={`${t('common.delete')} ${name}`} data-tooltip={t('common.delete')}
          onClick={() => remove(parent, name)}><Trash2 size={14} /></button>}
      </div>}
    </div>
    {typeof object?.description === 'string' && <p className="tool-parameter-description">{object.description}</p>}
    {object && <SchemaConstraints schema={object} />}
    {!editable && <details className="tool-parameter-advanced"><summary>{t('custom_tools.parameter_advanced')}</summary><pre className="ui-code-block">{JSON.stringify(value, null, 2)}</pre></details>}
    {nested && expanded && (depth < 12 ? <ParameterChildren schema={object} path={path} depth={depth + 1} edit={edit} remove={remove} source={source} />
      : <button className="ui-button ui-button-compact" type="button" onClick={source}><Code size={14} />{t('custom_tools.parameter_deep')}</button>)}
  </div>
}

function SchemaConstraints({ schema }: { schema: SchemaObject }) {
  const { t } = useTranslation()
  const constraints = Object.entries(schema).filter(([key, value]) => {
    if (displayedKeywords.has(key)) return false
    if (schema.type === 'object') {
      if (key === 'properties') return false
      if (key === 'required' && Array.isArray(value)) {
        return value.some(name => !isSchemaObject(schema.properties) || !Object.hasOwn(schema.properties, name))
      }
    }
    return !(schema.type === 'array' && key === 'items' && !Array.isArray(value))
  })
  if (!constraints.length) return null
  return <details className="tool-parameter-advanced"><summary>{t('custom_tools.parameter_constraints')}</summary>
    <dl className="tool-parameter-constraints">{constraints.map(([key, value]) => <div key={key}><dt>{t(`custom_tools.parameter_${key}`, { defaultValue: key })}</dt>
      <dd><code>{JSON.stringify(value)}</code></dd></div>)}</dl>
  </details>
}

function ParameterEditor({ target, schema, onClose, onApply, onBusyChange, onDirtyChange }: {
  target: EditTarget; schema: SchemaObject; onClose(): void; onApply(name: string, node: SchemaObject, required: boolean | undefined): Promise<void>
  onBusyChange(busy: boolean): void; onDirtyChange?(dirty: boolean): void
}) {
  const { t } = useTranslation()
  const defaultHintId = useId()
  const container = target.path.length ? schemaAt(schema, target.path.slice(0, -1)) : undefined
  const initial = target.adding ? { type: 'string' } : target.path.at(-1) === 'items' && isSchemaObject(container) && container.items === undefined ? {} : schemaAt(schema, target.path)
  const [draft, setDraft] = useState<SchemaObject>(() => isSchemaObject(initial) ? initial : {})
  const [name, setName] = useState(target.name ?? '')
  const parent = target.parent !== undefined ? schemaAt(schema, target.parent) : undefined
  const [requiredChoice, setRequiredChoice] = useState<boolean>()
  const required = requiredChoice ?? Boolean(isSchemaObject(parent) && Array.isArray(parent.required)
    && (parent.required.includes(target.name) || parent.required.includes(name)))
  const [enumText, setEnumText] = useState(draft.enum === undefined ? '' : JSON.stringify(draft.enum))
  const [defaultText, setDefaultText] = useState(draft.default === undefined ? '' : JSON.stringify(draft.default))
  const [numericText, setNumericText] = useState<Record<string, string>>(() => Object.fromEntries(numericKeywords.map(key => [key, draft[key] === undefined ? '' : String(draft[key])])))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [discard, setDiscard] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const currentDraft = JSON.stringify({ draft, name, requiredChoice, enumText, defaultText, numericText })
  const [initialDraft] = useState(currentDraft)
  const dirty = currentDraft !== initialDraft
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => { heading.current?.focus() }, [])
  const type = parameterType(draft)
  const root = !target.adding && !target.path.length
  function field(key: string, value: unknown) {
    setDraft(current => { const next = { ...current }; if (value === undefined) delete next[key]; else next[key] = value; return next })
  }
  async function apply() {
    setBusy(true); onBusyChange(true); setError('')
    try {
      const next = { ...draft }
      for (const [key, text] of Object.entries(numericText)) {
        if (!text.trim()) delete next[key]
        else next[key] = Number.isFinite(Number(text)) ? Number(text) : text
      }
      for (const [key, text] of [['enum', enumText], ['default', defaultText]]) {
        if (text.trim()) next[key] = JSON.parse(text)
        else delete next[key]
      }
      if (next.enum !== undefined && !Array.isArray(next.enum)) throw new Error(t('custom_tools.parameter_enum_invalid'))
      for (const [min, max] of [['minLength', 'maxLength'], ['minimum', 'maximum'], ['minItems', 'maxItems'], ['minProperties', 'maxProperties']]) {
        if (typeof next[min] === 'number' && typeof next[max] === 'number' && next[min] > next[max]) throw new Error(t('custom_tools.parameter_range_invalid'))
      }
      await onApply(name, next, requiredChoice)
    } catch (reason) {
      const message = errorDetail(reason)
      setError(message.startsWith('custom_tools.') ? t(message) : message)
    } finally { setBusy(false); onBusyChange(false) }
  }
  function close() { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
  const pick = (label: string, value: string, options: { value: string; label: string }[], onChange: (value: string) => void) =>
    <div className="ui-field-stack"><span>{label}</span><SearchableOptionPicker ariaLabel={label} emptyLabel={t('settings.no_options')} searchable={false} value={value} options={options} onChange={onChange} /></div>
  return <>
      <fieldset className="ui-form-section tool-parameter-editor" disabled={busy} aria-label={t(target.adding ? 'custom_tools.parameter_add' : 'custom_tools.parameter_edit')}>
      <h3 className="ui-section-title" ref={heading} tabIndex={-1}>{t(target.adding ? 'custom_tools.parameter_add' : 'custom_tools.parameter_edit')}{target.name && <> · <code>{target.name}</code></>}</h3>
      <p className="ui-field-hint">{t('custom_tools.parameter_edit_hint')}</p>
        {!root && <div className="ui-grid-auto">
          {target.parent !== undefined && <label className="ui-field-stack"><span>{t('custom_tools.parameter_name')}</span><input className="ui-input" value={name} onChange={event => setName(event.target.value)} /></label>}
          {pick(t('custom_tools.parameter_type'), type, parameterTypes.map(value => ({ value, label: t(`custom_tools.parameter_type_${value}`) })), value => {
            setDraft(current => current.type === value ? current : { ...current, type: value })
          })}
        </div>}
        {target.parent !== undefined && <CheckboxField label={t('custom_tools.parameter_required')} checked={required} onChange={setRequiredChoice} />}
        <label className="ui-field-stack"><span>{t('custom_tools.description')}</span><textarea className="ui-textarea" rows={2} value={typeof draft.description === 'string' ? draft.description : ''} onChange={event => field('description', event.target.value || undefined)} /></label>
        <details className="tool-parameter-advanced"><summary>{t('custom_tools.parameter_constraints')}</summary><div className="ui-form-section">
          {(numericConstraints[type] ?? []).map(key => <div className="ui-field-stack" key={key}>
            <label className="ui-field-label" htmlFor={`${defaultHintId}-${key}`}>{t(`custom_tools.parameter_${key}`)}</label>
            <CommitNumberInput id={`${defaultHintId}-${key}`} integer={false} disabled={busy} value={numericText[key]}
              onDraftChange={value => setNumericText(current => ({ ...current, [key]: value }))}
              onCommit={value => setNumericText(current => ({ ...current, [key]: value }))} /></div>)}
          {type === 'string' && ['pattern', 'format'].map(key => <label className="ui-field-stack" key={key}><span>{t(`custom_tools.parameter_${key}`)}</span><input className="ui-input" value={typeof draft[key] === 'string' ? draft[key] : ''} onChange={event => field(key, event.target.value || undefined)} /></label>)}
          {type === 'array' && <CheckboxField label={t('custom_tools.parameter_uniqueItems')} checked={draft.uniqueItems === true} onChange={value => field('uniqueItems', value)} />}
          {type === 'object' && pick(t('custom_tools.parameter_additionalProperties'), draft.additionalProperties === undefined ? 'unset' : typeof draft.additionalProperties === 'boolean' ? String(draft.additionalProperties) : 'custom',
            ['unset', 'true', 'false', ...(isSchemaObject(draft.additionalProperties) ? ['custom'] : [])].map(value => ({ value, label: t(`custom_tools.parameter_policy_${value}`) })),
            value => { if (value !== 'custom') field('additionalProperties', value === 'unset' ? undefined : value === 'true') })}
          <label className="ui-field-stack"><span>{t('custom_tools.parameter_enum')}</span><textarea className="ui-textarea ui-code-textarea" rows={2} value={enumText} placeholder='["a", "b"]' onChange={event => setEnumText(event.target.value)} /></label>
          <div className="ui-field-stack"><label className="ui-field-stack"><span>{t('custom_tools.parameter_default')}</span><textarea aria-describedby={defaultHintId} className="ui-textarea ui-code-textarea" rows={2} value={defaultText} onChange={event => setDefaultText(event.target.value)} /></label><small id={defaultHintId}>{t('custom_tools.parameter_default_hint')}</small></div>
        </div></details>
        {error && <p role="alert" className="ui-note ui-note-danger">{error}</p>}
        <div className="ui-toolbar tool-parameter-editor-actions"><button className="ui-button ui-button-compact" type="button" disabled={busy} onClick={close}><X size={14} />{t('custom_tools.parameter_cancel')}</button>
          <button className="ui-button ui-button-compact ui-button-primary" type="button" disabled={busy} onClick={() => void apply()}><Check size={14} />{t('custom_tools.parameter_apply')}</button></div>
      </fieldset>
      <ConfirmDialog request={discard ? { title: t('settings.file_discard_title'), description: t('settings.file_discard_hint'), onConfirm: onClose } : undefined}
        onClose={() => setDiscard(false)} />
  </>
}

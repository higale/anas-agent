import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { parsePluginManifest, type PluginSummary } from '@shared/plugins'
import { PluginPreferences } from './PluginPreferences'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { fields: string }) => {
  if (key === 'plugins.settings_saved_fields') return `${values?.fields} saved.`
  if (key === 'plugins.settings_empty_fields') return `${values?.fields} not filled in.`
  if (key === 'plugins.settings_field_separator') return ', '
  return key
}, i18n: { language: 'en' } }) }))
const plugin: PluginSummary = { id: 'test', enabled: true, backendStatus: 'stopped', manifest: parsePluginManifest({
  version: 0, api_version: 2, id: 'test', name: 'Test', plugin_version: '1.0.0', ui: 'index.html',
  settings: [{ key: 'label', label: 'Label', type: 'text', default: '' }]
}) }
const invoke = vi.fn()
beforeEach(() => {
  invoke.mockReset().mockResolvedValue({ values: { label: 'saved' }, revision: 'first' })
  Object.defineProperty(window, 'gale', { configurable: true, value: { plugins: { invoke } } })
})
it('keeps failed drafts across catalog refreshes, saves with the original revision and confirms discard', async () => {
  const view = render(<PluginPreferences plugin={plugin} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'common.edit' })).toBeEnabled())
  await userEvent.click(screen.getByRole('button', { name: 'common.edit' }))
  const dialog = within(screen.getByRole('dialog'))
  fireEvent.change(dialog.getByRole('textbox', { name: 'Label' }), { target: { value: 'draft' } })
  invoke.mockImplementation(async (_id, method) => {
    if (method === 'settings.set') throw new Error('Plugin settings changed. Reload before saving.')
    return { values: { label: 'remote' }, revision: 'second' }
  })
  await act(async () => { view.rerender(<PluginPreferences plugin={{ ...plugin, backendStatus: 'running' }} />) })
  expect(screen.queryByText('remote')).toBeNull()
  expect(dialog.getByRole('textbox', { name: 'Label' })).toHaveValue('draft')
  await userEvent.click(dialog.getByRole('button', { name: 'common.save' }))
  await waitFor(() => expect(dialog.getByRole('alert')).toHaveTextContent('plugins.settings_conflict'))
  expect(invoke).toHaveBeenCalledWith('test', 'settings.set', { values: { label: 'draft' }, revision: 'first' })
  expect(dialog.getByRole('textbox', { name: 'Label' })).toHaveValue('draft')
  await userEvent.click(dialog.getByRole('button', { name: 'common.cancel' }))
  expect(screen.getByRole('alertdialog')).toBeVisible()
  await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'common.cancel' }))
  expect(dialog.getByRole('textbox', { name: 'Label' })).toHaveValue('draft')
  await userEvent.click(dialog.getByRole('button', { name: 'common.refresh' }))
  await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'common.confirm' }))
  await waitFor(() => expect(dialog.getByRole('textbox', { name: 'Label' })).toHaveValue('remote'))
})

it('does not flash back to an older background read after saving settings', async () => {
  const view = render(<PluginPreferences plugin={plugin} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'common.edit' })).toBeEnabled())
  await userEvent.click(screen.getByRole('button', { name: 'common.edit' }))
  let finish!: (value: unknown) => void
  invoke.mockImplementation((_id, method) => method === 'settings.get'
    ? new Promise(resolve => { finish = resolve })
    : Promise.resolve({ values: { label: 'new saved' }, revision: 'new' }))
  view.rerender(<PluginPreferences plugin={{ ...plugin }} />)
  const dialog = within(screen.getByRole('dialog'))
  await userEvent.clear(dialog.getByRole('textbox', { name: 'Label' }))
  await userEvent.type(dialog.getByRole('textbox', { name: 'Label' }), 'new saved')
  await userEvent.click(dialog.getByRole('button', { name: 'common.save' }))
  expect(screen.getByText('Label saved.')).toBeVisible()
  expect(screen.queryByText('new saved')).toBeNull()
  await act(async () => finish({ values: { label: 'old value' }, revision: 'old' }))
  expect(screen.queryByText('old value')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'common.edit' }))
  expect(within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Label' })).toHaveValue('new saved')
})

it('locks pending saves without disabling the form, preserves failed drafts and blocks duplicate actions', async () => {
  render(<PluginPreferences plugin={plugin} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'common.edit' })).toBeEnabled())
  await userEvent.click(screen.getByRole('button', { name: 'common.edit' }))
  const content = screen.getByRole('dialog')
  const dialog = within(content)
  const input = dialog.getByRole('textbox', { name: 'Label' })
  fireEvent.change(input, { target: { value: 'draft' } })
  let fail!: (error: Error) => void
  invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  const save = dialog.getByRole('button', { name: 'common.save' })
  await userEvent.click(save)
  expect(content).toHaveAttribute('aria-busy', 'true')
  expect(input.closest('fieldset')).toHaveAttribute('inert')
  expect(input).toBeEnabled()
  expect(save).toBeEnabled()
  await userEvent.click(save)
  await userEvent.click(dialog.getByRole('button', { name: 'common.cancel' }))
  expect(invoke.mock.calls.filter(([, method]) => method === 'settings.set')).toHaveLength(1)
  expect(content).toBeInTheDocument()
  await act(async () => fail(new Error('disk failure')))
  expect(input).toHaveValue('draft')
  expect(input.closest('fieldset')).not.toHaveAttribute('inert')
  expect(dialog.getByRole('alert')).toHaveTextContent('disk failure')
})

it('shows only saved status outside the dialog and reveals password values only while editing', async () => {
  const secured: PluginSummary = { ...plugin, manifest: parsePluginManifest({
    version: 0, api_version: 2, id: 'test', name: 'Test', plugin_version: '1.0.0', ui: 'index.html',
    settings: [{ key: 'query_key', label: 'Query key', type: 'password', default: '' }]
  }) }
  invoke.mockResolvedValue({ values: { query_key: 'saved-secret' }, revision: 'first' })
  render(<PluginPreferences plugin={secured} />)
  expect(await screen.findByText('Query key saved.')).toBeVisible()
  expect(screen.queryByLabelText('Query key')).toBeNull()
  expect(screen.queryByText('saved-secret')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'common.edit' }))
  const dialog = within(screen.getByRole('dialog'))
  const input = dialog.getByLabelText('Query key')
  // The dialog automatically focuses its first field, just as the model editor does.
  fireEvent.blur(input)
  expect(input).toHaveAttribute('type', 'password')
  fireEvent.mouseEnter(input)
  expect(input).toHaveAttribute('type', 'text')
  fireEvent.mouseLeave(input)
  expect(input).toHaveAttribute('type', 'password')
  fireEvent.focus(input)
  expect(input).toHaveAttribute('type', 'text')
  fireEvent.change(input, { target: { value: 'changed-secret' } })
  fireEvent.blur(input)
  expect(input).toHaveAttribute('type', 'password')
  invoke.mockResolvedValueOnce({ values: { query_key: 'changed-secret' }, revision: 'second' })
  await userEvent.click(dialog.getByRole('button', { name: 'common.save' }))
  expect(invoke).toHaveBeenCalledWith('test', 'settings.set', { values: { query_key: 'changed-secret' }, revision: 'first' })
  expect(screen.queryByText('changed-secret')).toBeNull()
  expect(screen.queryByLabelText('Query key')).toBeNull()
  expect(screen.getByText('Query key saved.')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'common.edit' }))
  const reopened = within(screen.getByRole('dialog'))
  expect(reopened.getByLabelText('Query key')).toHaveValue('changed-secret')
  fireEvent.change(reopened.getByLabelText('Query key'), { target: { value: '' } })
  invoke.mockResolvedValueOnce({ values: { query_key: '' }, revision: 'third' })
  await userEvent.click(reopened.getByRole('button', { name: 'common.save' }))
  expect(screen.getByText('Query key not filled in.')).toBeVisible()
  expect(screen.queryByText('Query key saved.')).toBeNull()
})

it('uses the localized settings title and reports partial configuration without treating false or zero as missing', async () => {
  const partial: PluginSummary = { ...plugin, languages: [{ code: 'en', name: 'English', pluginSettingsTitle: 'Tencent Cloud settings' }],
    manifest: parsePluginManifest({ version: 0, api_version: 2, id: 'test', name: 'Test', plugin_version: '1.0.0', ui: 'index.html',
      settings_title: 'Fallback settings', settings: [
        { key: 'query_id', label: 'Tencent SecretId', type: 'text', default: '' },
        { key: 'query_key', label: 'Tencent SecretKey', type: 'password', default: '' },
        { key: 'count', label: 'Count', type: 'number', default: 0 },
        { key: 'enabled', label: 'Enabled', type: 'boolean', default: false }
      ] }) }
  invoke.mockResolvedValue({ values: { query_id: 'private-id', query_key: '  ', count: 0, enabled: false }, revision: 'first' })
  render(<PluginPreferences plugin={partial} />)
  expect(await screen.findByText('Tencent SecretId, Count, Enabled saved.')).toBeVisible()
  expect(screen.getByText('Tencent SecretKey not filled in.')).toBeVisible()
  expect(screen.getByText('Tencent Cloud settings')).toBeVisible()
  expect(screen.queryByText('private-id')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'common.edit' }))
  expect(screen.getByRole('dialog', { name: 'Tencent Cloud settings' })).toBeVisible()
})

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { parsePluginManifest, type PluginSummary } from '@shared/plugins'
import { PluginPreferences } from './PluginPreferences'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
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
  view.rerender(<PluginPreferences plugin={{ ...plugin, backendStatus: 'running' }} />)
  await waitFor(() => expect(screen.getByText('remote')).toBeVisible())
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
  expect(screen.getByText('new saved')).toBeVisible()
  await act(async () => finish({ values: { label: 'old value' }, revision: 'old' }))
  expect(screen.getByText('new saved')).toBeVisible()
  expect(screen.queryByText('old value')).toBeNull()
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

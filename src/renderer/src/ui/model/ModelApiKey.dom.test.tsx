import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { ModelEditor } from './ModelEditor'
import { emptyModelDraft } from './modelDraft'
import { useModelCandidateRefresh } from './useModelCandidateRefresh'
import { notice } from '../notice'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./ProviderIconField', () => ({ ProviderIconField: () => null }))
vi.mock('../notice', () => ({ notice: { error: vi.fn(), success: vi.fn() } }))
const listVariables = vi.fn()
const updateDraft = vi.fn()

function Editor({ initial = '' }: { initial?: string }) {
  const [draft, setDraft] = useState({ ...emptyModelDraft(), apiKey: initial })
  return <ModelEditor candidates={[]} listLoading={false} modelDraft={draft} onRefreshCandidates={vi.fn()}
    onSaveDetails={vi.fn()} onUpdateDraft={update => { updateDraft(update); setDraft(current => ({ ...current, ...update })) }} />
}

beforeEach(() => {
  listVariables.mockReset().mockResolvedValue([
    { name: 'apiToken', source: 'envFile', hasValue: true },
    { name: 'APITOKEN', source: 'system', hasValue: true },
    { name: 'EMPTY_KEY', source: 'system', hasValue: false }
  ])
  updateDraft.mockReset()
  vi.stubGlobal('gale', { app: { listApiKeyEnvironmentVariables: listVariables } })
})
afterEach(() => vi.unstubAllGlobals())

describe('model API key input', () => {
  it('distinguishes whitespace in suggestion labels and preserves it when selecting or typing a reference', async () => {
    listVariables.mockResolvedValue([
      { name: ' TEST_API_KEY ', source: 'system', hasValue: true },
      { name: 'TEST_API_KEY', source: 'system', hasValue: true }
    ])
    render(<Editor initial="${TEST_API_KEY}" />)
    const input = screen.getByRole('combobox', { name: 'settings.api_key' })
    const trigger = screen.getByRole('button', { name: 'settings.api_key' })
    await userEvent.click(trigger)
    const spacedOption = await screen.findByRole('option', { name: '" TEST_API_KEY "' })
    expect(spacedOption).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('option', { name: 'TEST_API_KEY' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(spacedOption)
    expect(updateDraft).toHaveBeenLastCalledWith({ apiKey: '${ TEST_API_KEY }' })
    expect(input).toHaveValue('${ TEST_API_KEY }')
    expect(input).toHaveAttribute('type', 'text')
    await userEvent.click(input)
    fireEvent.change(input, { target: { value: '${ TEST_API_KEY}' } })
    await userEvent.tab()
    expect(updateDraft).toHaveBeenLastCalledWith({ apiKey: '${ TEST_API_KEY}' })
    expect(input).toHaveAttribute('type', 'text')
  })

  it('allows keyboard selection when suggestions arrive after the popover opens', async () => {
    let finish!: (value: unknown) => void
    listVariables.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    render(<Editor />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.api_key' }))
    await waitFor(() => expect(screen.getByRole('listbox')).toHaveFocus())
    await act(async () => finish([{ name: 'MY_KEY', source: 'envFile', hasValue: true }]))
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(updateDraft).toHaveBeenLastCalledWith({ apiKey: '${MY_KEY}' })
  })

  it('reports which variable is missing when refreshing the model list', async () => {
    vi.stubGlobal('gale', { config: { fetchModels: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'config:fetchModels': Error: API key environment variable MY_CREDENTIAL is missing or empty.")) } })
    const t = vi.fn((key: string) => key) as unknown as TFunction
    const { result } = renderHook(() => useModelCandidateRefresh({
      modelDraft: { ...emptyModelDraft(), baseUrl: 'https://example.test/v1', apiKey: '${MY_CREDENTIAL}' }, setModelCandidates: vi.fn(), t
    }))
    await act(async () => result.current.refreshModelCandidates())
    expect(t).toHaveBeenCalledWith('settings.api_key_variable_missing', { name: 'MY_CREDENTIAL' })
    expect(notice.error).toHaveBeenCalledWith('settings.api_key_variable_missing')
  })

  it('loads suggestions on opening, groups sources, has no search, and preserves exact reference names', async () => {
    render(<Editor initial="${apiToken}" />)
    expect(listVariables).not.toHaveBeenCalled()
    const input = screen.getByRole('combobox', { name: 'settings.api_key' })
    expect(input).toHaveAttribute('type', 'text')
    await userEvent.click(screen.getByRole('button', { name: 'settings.api_key' }))
    const first = await screen.findByRole('option', { name: 'apiToken' })
    expect(first).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'APITOKEN' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByText('.env')).toBeVisible()
    expect(screen.getByText('settings.system_environment_variables')).toBeVisible()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: 'EMPTY_KEY (settings.api_key_variable_empty)' }))
    expect(updateDraft).toHaveBeenLastCalledWith({ apiKey: '${EMPTY_KEY}' })
    expect(input).toHaveValue('${EMPTY_KEY}')
    expect(input).toHaveAttribute('type', 'text')
  })

  it('accepts a manually typed reference absent from suggestions and commits on blur', async () => {
    render(<Editor />)
    const input = screen.getByRole('combobox', { name: 'settings.api_key' })
    await userEvent.click(input)
    fireEvent.change(input, { target: { value: '${CUSTOM_CREDENTIAL}' } })
    expect(updateDraft).not.toHaveBeenCalled()
    await userEvent.tab()
    expect(updateDraft).toHaveBeenLastCalledWith({ apiKey: '${CUSTOM_CREDENTIAL}' })
    expect(input).toHaveAttribute('type', 'text')
    expect(listVariables).not.toHaveBeenCalled()
  })

  it('keeps literal keys editable and masked outside focus, and Escape cancels a draft', async () => {
    render(<Editor initial="original-secret" />)
    const input = screen.getByRole('combobox', { name: 'settings.api_key' })
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.click(input)
    expect(input).toHaveAttribute('type', 'text')
    fireEvent.change(input, { target: { value: 'new-secret' } })
    await userEvent.keyboard('{Enter}')
    expect(updateDraft).toHaveBeenLastCalledWith({ apiKey: 'new-secret' })
    expect(input).toHaveAttribute('type', 'password')
    updateDraft.mockClear()
    await userEvent.click(input)
    fireEvent.change(input, { target: { value: 'discarded' } })
    await userEvent.keyboard('{Escape}')
    expect(input).toHaveValue('new-secret')
    expect(updateDraft).not.toHaveBeenCalled()
  })

  it('reports a failed load without losing input and retries with fresh suggestions on reopening', async () => {
    listVariables.mockRejectedValueOnce(new Error('Failed'))
    render(<Editor initial="${apiToken}" />)
    const trigger = screen.getByRole('button', { name: 'settings.api_key' })
    await userEvent.click(trigger)
    expect(await screen.findByText('settings.api_key_variables_failed')).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'settings.api_key' })).toHaveValue('${apiToken}')
    await userEvent.keyboard('{Escape}')
    await userEvent.click(trigger)
    await waitFor(() => expect(screen.getByRole('option', { name: 'apiToken' })).toBeVisible())
    expect(listVariables).toHaveBeenCalledTimes(2)
  })
})

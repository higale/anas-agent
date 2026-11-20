import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import type { GaleApi } from '@shared/types'
import { BundledPythonSettings } from './BundledPythonSettings'
import { notice } from '../notice'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../notice', () => ({ notice: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
const reset = vi.fn()
beforeEach(() => {
  reset.mockReset()
  window.gale = { app: { resetBundledPython: reset } } as unknown as GaleApi
})

it('requires explicit confirmation and keeps the reset button disabled until replacement completes', async () => {
  let complete!: () => void
  reset.mockReturnValue(new Promise<void>(resolve => { complete = resolve }))
  const user = userEvent.setup()
  render(<BundledPythonSettings />)
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'settings.python_reset' }))
  expect(screen.getByText('settings.python_reset_confirm')).toBeVisible()
  expect(reset).not.toHaveBeenCalled()
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'common.cancel' }))
  expect(reset).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'settings.python_reset' }))
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'settings.python_reset' }))
  expect(screen.getByRole('button', { name: 'settings.python_resetting' })).toBeDisabled()
  expect(reset).toHaveBeenCalledTimes(1)
  await act(async () => complete())
  expect(screen.getByRole('button', { name: 'settings.python_reset' })).toBeEnabled()
  expect(notice.success).toHaveBeenCalledWith('settings.python_reset_success', { id: 'python-startup', description: '' })
})

it('reports a failure and allows another explicit reset attempt', async () => {
  reset.mockRejectedValue(new Error('Disk full'))
  const user = userEvent.setup()
  render(<BundledPythonSettings />)
  await user.click(screen.getByRole('button', { name: 'settings.python_reset' }))
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'settings.python_reset' }))
  await waitFor(() => expect(notice.error).toHaveBeenCalledWith('settings.python_reset_failed', {
    id: 'python-startup', description: 'Disk full', duration: Infinity
  }))
  expect(screen.getByRole('button', { name: 'settings.python_reset' })).toBeEnabled()
})

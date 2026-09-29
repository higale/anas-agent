import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { LogSettings } from './LogSettings'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

it('offers separate explicit actions for the log directory and log viewer', async () => {
  const onOpenLogDirectory = vi.fn()
  const onOpenRuntimeLogViewer = vi.fn()
  render(<LogSettings settings={undefined} onChange={vi.fn()}
    onOpenLogDirectory={onOpenLogDirectory} onOpenRuntimeLogViewer={onOpenRuntimeLogViewer} />)
  expect(screen.queryByRole('button', { name: 'settings.log_files' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'settings.open_log_folder' }))
  expect(onOpenLogDirectory).toHaveBeenCalledOnce()
  expect(onOpenRuntimeLogViewer).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'settings.open_log_viewer' }))
  expect(onOpenRuntimeLogViewer).toHaveBeenCalledOnce()
})

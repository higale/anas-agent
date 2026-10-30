import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataRestoreResult } from '@shared/types'
import { DataRestoreView } from './DataRestoreView'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const restore = vi.fn()
beforeEach(() => {
  restore.mockReset()
  Object.defineProperty(window, 'gale', { configurable: true, value: { app: { restoreData: restore } } })
})

describe('data restore view', () => {
  it('restores once under StrictMode and waits for completion before reloading', async () => {
    let complete!: (result: DataRestoreResult) => void
    restore.mockReturnValue(new Promise<DataRestoreResult>(resolve => { complete = resolve }))
    const reload = vi.fn()
    render(<StrictMode><DataRestoreView sourcePath="/backup.zip" onReload={reload} /></StrictMode>)
    expect(screen.getByRole('status')).toHaveTextContent('settings.restoring_data')
    expect(restore).toHaveBeenCalledExactlyOnceWith('/backup.zip')
    expect(reload).not.toHaveBeenCalled()
    await act(async () => complete({ path: '/backup.zip', preRestoreBackupPath: '/previous.zip', fileCount: 1, size: 100 }))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('keeps the actual failure visible and reloads only when requested', async () => {
    restore.mockRejectedValue(new Error('Could not save original data: disk full'))
    const reload = vi.fn()
    render(<StrictMode><DataRestoreView sourcePath="/backup.zip" onReload={reload} /></StrictMode>)
    const failure = await screen.findByRole('alert')
    expect(failure).toHaveTextContent('settings.failed_restore_data')
    expect(failure).toHaveTextContent('Could not save original data: disk full')
    expect(reload).not.toHaveBeenCalled()
    expect(restore).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'common.reload' }))
    expect(reload).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
  })

  it('does not reload an unrelated screen after unmount', async () => {
    let complete!: (result: DataRestoreResult) => void
    restore.mockReturnValue(new Promise<DataRestoreResult>(resolve => { complete = resolve }))
    const reload = vi.fn()
    const view = render(<DataRestoreView sourcePath="/backup.zip" onReload={reload} />)
    view.unmount()
    await act(async () => complete({ path: '/backup.zip', preRestoreBackupPath: '/previous.zip', fileCount: 1, size: 100 }))
    expect(reload).not.toHaveBeenCalled()
  })
})

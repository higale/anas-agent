import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DataManagementSettings } from './DataManagementSettings'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('DataManagementSettings', () => {
  it('opens the data directory with an explicit action and keeps storage usage visible', async () => {
    const onOpenDataDirectory = vi.fn()
    render(
      <DataManagementSettings
        dataDirectoryUsage={{ totalBytes: 1536, approximate: false }}
        storageUsageLoading={false}
        onBackupDataDirectory={vi.fn()}
        onOpenDataCleanup={vi.fn()}
        onOpenDataDirectory={onOpenDataDirectory}
        onRestoreDataDirectory={vi.fn()}
      />
    )

    const usage = screen.getByText('1.50 KB')
    expect(usage).toBeVisible()
    expect(screen.queryByRole('button', { name: 'settings.data_directory' })).not.toBeInTheDocument()
    expect(screen.getByText('settings.data_directory').parentElement).not.toContainElement(usage)
    await userEvent.click(screen.getByRole('button', { name: 'common.open' }))
    expect(onOpenDataDirectory).toHaveBeenCalledOnce()
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DataCleanupDialog } from './DataCleanupDialog'
import { dataCleanupTargets, defaultDataCleanupSelection } from './dialogTypes'
import type { DataCleanupUsage } from './dialogTypes'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('DataCleanupDialog', () => {
  const emptyUsage = () => Object.fromEntries(dataCleanupTargets.map(target => [target, {
    totalBytes: 100, approximate: false, hasData: false
  }])) as DataCleanupUsage
  const baseProps = { open: true, selection: defaultDataCleanupSelection(), busy: false, storageUsageLoading: false,
    onToggle: vi.fn(), onToggleAll: vi.fn(), onClose: vi.fn(), onRun: vi.fn() }

  it('hides confirmed empty items regardless of storage overhead and ignores their prior selection', () => {
    render(<DataCleanupDialog {...baseProps} usage={emptyUsage()} />)
    expect(screen.getByText('settings.cleanup_empty')).toBeVisible()
    expect(screen.queryByText('settings.cleanup_input_history')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'settings.cleanup_selected' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'menu.select_all' })).toBeDisabled()
  })

  it('shows zero-byte unknown entries, leaves them unchecked and exposes the actual preview', () => {
    render(<DataCleanupDialog {...baseProps} usage={{ ...emptyUsage(), unknown_files: { totalBytes: 0, approximate: false, hasData: true } }} unknownFiles={['old-empty', 'backup.zip']} />)
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes[0]).not.toBeChecked()
    expect(checkboxes[0]).not.toBeDisabled()
    fireEvent.click(screen.getByText('settings.cleanup_unknown_files_preview'))
    expect(screen.getByText(/old-empty/)).toBeVisible()
    expect(screen.getByText(/backup.zip/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'settings.cleanup_selected' })).toBeDisabled()
  })

  it('keeps unmeasured items visible while preventing unknown-file cleanup without a preview', () => {
    render(<DataCleanupDialog {...baseProps} usage={{}} />)
    expect(screen.getByText('settings.cleanup_cache_folder')).toBeVisible()
    const unknown = screen.getByText('settings.cleanup_unknown_files').closest('label')!
    expect(unknown.querySelector('[role="checkbox"],input')).toBeDisabled()
  })

  it('shows total storage usage for every measurable cleanup item', async () => {
    render(
      <DataCleanupDialog
        open
        selection={defaultDataCleanupSelection()}
        busy={false}
        storageUsageLoading={false}
        usage={{
          agent_unpinned_threads: { totalBytes: 2048, approximate: true },
          memories: { totalBytes: 1024, approximate: true },
          input_history: { totalBytes: 100, approximate: false },
          cache_folder: { totalBytes: 3000, approximate: true },
          temp_folder: { totalBytes: 4000, approximate: false },
          log_folder: { totalBytes: 5000, approximate: false },
          developer_http_trace: { totalBytes: 6000, approximate: false }
        }}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
        onClose={vi.fn()}
        onRun={vi.fn()}
      />
    )

    expect(await screen.findByText('≈ 2.00 KB')).toBeVisible()
    expect(screen.getByText('≈ 1.00 KB')).toBeVisible()
    expect(screen.getByText('100 B')).toBeVisible()
    expect(screen.getByText('≈ 2.93 KB')).toBeVisible()
    expect(screen.getByText('3.91 KB')).toBeVisible()
    expect(screen.getByText('4.88 KB')).toBeVisible()
    expect(screen.getByText('5.86 KB')).toBeVisible()
  })
})

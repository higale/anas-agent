import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ModelDetailsDialog } from './ModelDetailsDialog'
import { emptyModelDraft } from './modelDraft'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
function mount() {
  const onSave = vi.fn(async () => {})
  const view = render(<ModelDetailsDialog candidates={[]} listLoading={false} open
    modelDraft={{ ...emptyModelDraft(), providerId: 'provider', model: 'fixture' }} onOpenChange={vi.fn()}
    onRefreshCandidates={vi.fn()} onSaveDetails={onSave} />)
  return { ...view, onSave }
}
async function limits() {
  await userEvent.click(screen.getByRole('button', { name: 'settings.image_limits' }))
  return within(screen.getByRole('dialog', { name: 'settings.image_limits' }))
}
describe('model image limits draft', () => {
  it('keeps limits out of the main form, stages confirmation and persists only on parent save', async () => {
    const { onSave } = mount()
    expect(screen.queryByLabelText('settings.image_limit_maxBytes')).not.toBeInTheDocument()
    const dialog = await limits()
    fireEvent.change(dialog.getByLabelText('settings.image_limit_maxBytes'), { target: { value: '1,500,000' } })
    expect(dialog.getByLabelText('settings.image_limit_maxBytes')).toHaveValue('1,500,000')
    expect(dialog.getByText('1.5 M')).toBeInTheDocument()
    fireEvent.change(dialog.getByLabelText('settings.image_limit_maxCount'), { target: { value: '0' } })
    await userEvent.click(dialog.getByRole('button', { name: 'common.confirm' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('checkbox', { name: 'settings.model_capability_vision' })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ imageLimits: { maxBytes: 1_500_000, byteBasis: 'original', maxCount: 0 } }))
  })
  it('discards child cancellation, rejects conflicting dimensions, and clears limits', async () => {
    const { onSave } = mount()
    let dialog = await limits()
    fireEvent.change(dialog.getByLabelText('settings.image_limit_minShortSide'), { target: { value: '11' } })
    await userEvent.click(dialog.getByRole('button', { name: 'common.cancel' }))
    dialog = await limits()
    expect(dialog.getByLabelText('settings.image_limit_minShortSide')).toHaveValue('')
    fireEvent.change(dialog.getByLabelText('settings.image_limit_minShortSide'), { target: { value: '20' } })
    fireEvent.change(dialog.getByLabelText('settings.image_limit_maxLongSide'), { target: { value: '10' } })
    await userEvent.click(dialog.getByRole('button', { name: 'common.confirm' }))
    expect(dialog.getByRole('alert')).toHaveTextContent('settings.image_limits_invalid')
    await userEvent.click(dialog.getByRole('button', { name: 'settings.image_limits_clear' }))
    await userEvent.click(dialog.getByRole('button', { name: 'common.confirm' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(onSave).not.toHaveBeenCalled()
  })
})

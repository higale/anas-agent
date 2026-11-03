import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { PanelPreferencesSnapshot } from '@shared/panels'
import { MemoryActivityPanel } from './MemoryActivityPanel'
import { notice } from '../notice'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))

function preferences(revision: number, showMemoryActivityInTitlebar: boolean): PanelPreferencesSnapshot {
  return { revision, showMemoryActivityInTitlebar, diffViewMode: 'inline', diffFoldUnchanged: true, diffWordWrap: true }
}

async function openPanel(updatePreferences: () => Promise<PanelPreferencesSnapshot>) {
  Object.defineProperty(window, 'gale', { configurable: true, value: {
    panels: { updatePreferences },
    preferences: { activity: async () => ({ status: 'idle' }), onChanged: () => () => {} }
  } })
  const view = render(<MemoryActivityPanel preferences={preferences(0, true)} />)
  await screen.findByText('memory_activity.idle')
  return { checkbox: screen.getByRole('checkbox'), receive: (revision: number, value: boolean) =>
    view.rerender(<MemoryActivityPanel preferences={preferences(revision, value)} />) }
}

it.each(['save first', 'notification first'])('keeps the confirmed value regardless of notification order (%s)', async order => {
  let finish!: (value: PanelPreferencesSnapshot) => void
  const save = vi.fn(() => new Promise<PanelPreferencesSnapshot>(resolve => { finish = resolve }))
  const { checkbox, receive } = await openPanel(save)
  fireEvent.click(checkbox)
  expect(save).toHaveBeenCalledWith({ showMemoryActivityInTitlebar: false })
  if (order === 'notification first') receive(1, false)
  expect(checkbox).not.toBeChecked()
  expect(checkbox).toBeDisabled()
  await act(async () => finish(preferences(1, false)))
  expect(checkbox).not.toBeChecked()
  expect(checkbox).toBeEnabled()
  if (order === 'save first') receive(1, false)
  receive(2, true)
  expect(checkbox).toBeChecked()
})

it('prefers a newer broadcast to an older save response', async () => {
  let finish!: (value: PanelPreferencesSnapshot) => void
  const { checkbox, receive } = await openPanel(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(checkbox)
  receive(2, true)
  await act(async () => finish(preferences(1, false)))
  expect(checkbox).toBeChecked()
  expect(checkbox).toBeEnabled()
})

it('restores the confirmed value and allows retry after a failed save', async () => {
  const save = vi.fn().mockResolvedValueOnce(preferences(1, false))
    .mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce(preferences(2, true))
  const { checkbox } = await openPanel(save)
  await act(async () => { fireEvent.click(checkbox) })
  expect(checkbox).not.toBeChecked()
  await act(async () => { fireEvent.click(checkbox) })
  expect(notice.error).toHaveBeenCalled()
  expect(checkbox).not.toBeChecked()
  expect(checkbox).toBeEnabled()
  await act(async () => { fireEvent.click(checkbox) })
  expect(checkbox).toBeChecked()
  expect(checkbox).toBeEnabled()
})

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SubagentSelection } from '@shared/subagentSelection'
import { SubagentSelectionEditor } from './SubagentSelectionEditor'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

afterEach(() => vi.unstubAllGlobals())

const toggle = (name: string) => screen.getByRole('checkbox', { name })

it('edits global references, clears missing entries, without per-item modes', async () => {
  const user = userEvent.setup()
  const changed = vi.fn(), openDirectory = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('gale', { files: { openDirectory } })
  function Harness() {
    const [value, setValue] = useState<SubagentSelection>({ mode: 'custom', names: ['missing', 'disabled'] })
    return <SubagentSelectionEditor value={value} disabled={false}
      definitions={[{ name: 'researcher', directory: '/agents/researcher', description: 'Research documents', systemPrompt: 'Research.', enabled: true }, { name: 'disabled', description: 'Custom use.', systemPrompt: 'Complete task.', enabled: false }]}
      onChange={(next) => { setValue(next); changed(next) }} />
  }
  render(<Harness />)
  await user.click(screen.getByRole('button', { name: 'settings.capability_subagents' }))
  expect(toggle('disabled')).toBeChecked()
  expect(toggle('missing')).toHaveAccessibleDescription('capabilities.deleted')
  expect(screen.getByText('capabilities.deleted')).not.toBeVisible()
  expect(toggle('disabled')).toHaveAccessibleDescription('capabilities.globally_disabled')
  expect(screen.queryByText('capabilities.inactive')).toBeNull()
  expect(screen.getByText('2/3')).toBeInTheDocument()
  expect(changed).not.toHaveBeenCalled()
  await user.click(toggle('disabled'))
  expect(screen.getByText('1/3')).toBeInTheDocument()
  expect(toggle('disabled')).toBeEnabled()
  await user.click(toggle('disabled'))
  expect(toggle('disabled')).toBeChecked()
  expect(screen.getByText('2/3')).toBeInTheDocument()
  await user.click(toggle('missing'))
  expect(screen.queryByRole('checkbox', { name: 'missing' })).not.toBeInTheDocument()
  expect(screen.queryByRole('searchbox')).toBeNull()
  await user.click(toggle('researcher'))
  expect(changed).toHaveBeenLastCalledWith({ mode: 'custom', names: ['disabled', 'researcher'] })
  expect(screen.getAllByRole('radiogroup')).toHaveLength(1)
})

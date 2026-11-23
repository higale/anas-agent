import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { config } from '../../../../test/agentConfigurationFixture'
import { ChatModeSettings } from './ChatModeSettings'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

it('chooses or edits the default directory, keeps it on cancellation and clears it to use Documents', async () => {
  const chooseSourceFolders = vi.fn().mockResolvedValueOnce({ status: 'ok', value: [] })
    .mockResolvedValueOnce({ status: 'ok', value: ['/isolated/projects'] })
  Object.defineProperty(window, 'gale', { configurable: true, value: { projects: { chooseSourceFolders } } })
  const saved = vi.fn()
  function Fixture() {
    const [settings, setSettings] = useState(config().settings)
    return <ChatModeSettings settings={settings} onSpeechReplyChange={vi.fn()} onChange={update => {
      saved(update); setSettings(current => ({ ...current, ...update }))
    }} />
  }
  const user = userEvent.setup()
  render(<Fixture />)
  const input = screen.getByRole('textbox', { name: /settings.project_default_directory/ })
  expect(input).toHaveValue('')
  expect(input).toHaveAttribute('placeholder', 'settings.documents_directory')
  const choose = screen.getByRole('button', { name: 'settings.choose_project_default_directory' })
  await user.click(choose)
  expect(saved).not.toHaveBeenCalled()
  await user.click(choose)
  expect(chooseSourceFolders).toHaveBeenLastCalledWith(false)
  expect(input).toHaveValue('/isolated/projects')
  expect(saved).toHaveBeenLastCalledWith({ projectDefaultDirectory: '/isolated/projects' })
  await user.clear(input)
  await user.type(input, '/isolated/my projects')
  expect(input).toHaveValue('/isolated/my projects')
  expect(saved).toHaveBeenLastCalledWith({ projectDefaultDirectory: '/isolated/my projects' })
  await user.clear(input)
  expect(input).toHaveValue('')
  expect(saved).toHaveBeenLastCalledWith({ projectDefaultDirectory: '' })
})

import { environmentContextFixture } from '../../../../test/environmentContextFixture'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, EnvironmentContextSettings, GaleApi } from '@shared/types'
import { EnvironmentSettingsSections } from './EnvironmentSettingsSections'
import { notice } from '../notice'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const environmentMocks = vi.hoisted(() => ({
  detectSystemEnvironment: vi.fn()
}))

vi.mock('../notice', () => ({
  notice: { error: vi.fn(), info: vi.fn() }
}))

function appSettings(
  environmentContext: Partial<EnvironmentContextSettings> = {}
): AppSettings {
  return {
    environmentContext: environmentContextFixture({ customInformationEnabled: false, ...environmentContext })
  } as AppSettings
}

function EnvironmentSettingsHarness({
  initialSettings,
  onSaveSettings
}: {
  initialSettings: AppSettings
  onSaveSettings: (settings: Partial<AppSettings>) => void
}) {
  const [settings, setSettings] = useState(initialSettings)
  return (
    <EnvironmentSettingsSections
      envDraft=""
      settings={settings}
      sectionClass={() => 'environment-section'}
      onAutosizeInput={vi.fn()}
      onOpenEnvFile={vi.fn()}
      onSaveSettings={(update) => {
        onSaveSettings(update)
        setSettings((current) => ({ ...current, ...update }))
      }}
      onUpdateEnvDraft={vi.fn()}
    />
  )
}

describe('environment settings', () => {
  beforeEach(() => {
    environmentMocks.detectSystemEnvironment.mockReset()
    Object.defineProperty(window, 'gale', {
      configurable: true,
      value: {
        app: { detectSystemEnvironment: environmentMocks.detectSystemEnvironment }
      } as unknown as GaleApi
    })
  })

  it('enables custom environment information by default without detecting from settings', () => {
    const { unmount } = render(
      <EnvironmentSettingsSections
        envDraft=""
        settings={undefined}
        sectionClass={() => 'environment-section'}
        onAutosizeInput={vi.fn()}
        onOpenEnvFile={vi.fn()}
        onSaveSettings={vi.fn()}
        onUpdateEnvDraft={vi.fn()}
      />
    )

    expect(screen.getByRole('checkbox', {
      name: 'settings.custom_environment_information'
    })).toBeChecked()
    expect(environmentMocks.detectSystemEnvironment).not.toHaveBeenCalled()
    unmount()
  })

  it('lets users disable bundled command context independently of environment detection', async () => {
    const user = userEvent.setup()
    const onSaveSettings = vi.fn()
    render(<EnvironmentSettingsHarness initialSettings={appSettings()} onSaveSettings={onSaveSettings} />)
    const checkbox = screen.getByRole('checkbox', { name: 'settings.capability_bundledCommands' })
    expect(checkbox).toBeChecked()
    await user.click(checkbox)
    expect(onSaveSettings).toHaveBeenLastCalledWith({
      environmentContext: { ...appSettings().environmentContext, bundledCommands: false }
    })
    expect(checkbox).not.toBeChecked()
    expect(environmentMocks.detectSystemEnvironment).not.toHaveBeenCalled()
  })

  it('detects only on click and inserts results at the remembered cursor after the textarea loses focus', async () => {
    const user = userEvent.setup()
    const onSaveSettings = vi.fn()
    environmentMocks.detectSystemEnvironment.mockResolvedValue({
      content: 'Available development tools:\n- Python: Python 3.13.7 (python3)',
      tools: [{ name: 'Python', executable: 'python3', details: 'Python 3.13.7' }]
    })
    render(
      <EnvironmentSettingsHarness
        initialSettings={appSettings({ customInformation: 'Existing information.' })}
        onSaveSettings={onSaveSettings}
      />
    )
    const input = screen.getByRole('textbox', {
      name: /settings\.custom_environment_information/
    }) as HTMLTextAreaElement

    expect(environmentMocks.detectSystemEnvironment).not.toHaveBeenCalled()
    await user.type(input, ' Manual addition.')
    input.setSelectionRange('Existing information.'.length, 'Existing information.'.length)
    await user.click(screen.getByRole('button', { name: 'settings.detect_system_environment' }))

    const customInformation = 'Existing information.Available development tools:\n- Python: Python 3.13.7 (python3) Manual addition.'
    await waitFor(() => expect(onSaveSettings).toHaveBeenLastCalledWith({
      environmentContext: expect.objectContaining({
        customInformation,
        customInformationEnabled: false
      })
    }))
    expect(input).toHaveValue(customInformation)
    expect(input).not.toHaveFocus()
    expect(environmentMocks.detectSystemEnvironment).toHaveBeenCalledOnce()
  })

  it.each(['partial', 'all', 'start', 'end'])('inserts at the %s selection in the latest draft without extra separators', async selection => {
    const user = userEvent.setup()
    const onSaveSettings = vi.fn()
    const content = 'Available development tools:\n- Python 3.13.7'
    environmentMocks.detectSystemEnvironment.mockResolvedValue({ content, tools: [] })
    render(<EnvironmentSettingsHarness initialSettings={appSettings({ customInformation: 'Keep before.\nOld tools' })} onSaveSettings={onSaveSettings} />)
    const input = screen.getByRole('textbox', { name: 'settings.custom_environment_information' }) as HTMLTextAreaElement
    await user.type(input, '\nKeep after.  ')
    const draft = input.value
    if (selection === 'all') await user.keyboard('{Control>}a{/Control}')
    else if (selection === 'partial') input.setSelectionRange('Keep before.\n'.length, 'Keep before.\nOld tools'.length, 'backward')
    else if (selection === 'start') input.setSelectionRange(0, 0)
    const start = input.selectionStart, end = input.selectionEnd
    await user.click(screen.getByRole('button', { name: 'settings.detect_system_environment' }))

    const expected = `${draft.slice(0, start)}${content}${draft.slice(end)}`
    await waitFor(() => expect(input).toHaveValue(expected))
    expect(onSaveSettings).toHaveBeenLastCalledWith({
      environmentContext: expect.objectContaining({ customInformation: expected, customInformationEnabled: false })
    })
    await user.click(screen.getByRole('button', { name: 'settings.detect_system_environment' }))
    await waitFor(() => expect(input).toHaveValue(`${draft.slice(0, start)}${content}${content}${draft.slice(end)}`))
  })

  it('keeps edits made while detection is pending instead of replacing an outdated selection', async () => {
    const user = userEvent.setup()
    const onSaveSettings = vi.fn()
    let complete!: (result: { content: string; tools: [] }) => void
    environmentMocks.detectSystemEnvironment.mockReturnValue(new Promise(resolve => { complete = resolve }))
    render(<EnvironmentSettingsHarness initialSettings={appSettings({ customInformation: 'Old tools' })} onSaveSettings={onSaveSettings} />)
    const input = screen.getByRole('textbox', { name: 'settings.custom_environment_information' })
    await user.click(input)
    await user.keyboard('{Control>}a{/Control}')
    await user.click(screen.getByRole('button', { name: 'settings.detect_system_environment' }))
    await user.clear(input)
    await user.type(input, 'New manual information')
    await act(async () => { complete({ content: 'Detected tools', tools: [] }) })

    expect(input).toHaveValue('New manual information')
    expect(notice.info).toHaveBeenCalledWith('settings.environment_detection_content_changed')
    expect(onSaveSettings).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'settings.detect_system_environment' })).toBeEnabled()
    await user.tab()
    expect(onSaveSettings).toHaveBeenLastCalledWith({
      environmentContext: expect.objectContaining({ customInformation: 'New manual information' })
    })
  })

  it.each(['empty', 'failure'])('preserves the selected text when detection returns %s', async outcome => {
    const user = userEvent.setup()
    const onSaveSettings = vi.fn()
    if (outcome === 'empty') environmentMocks.detectSystemEnvironment.mockResolvedValue({ content: '', tools: [] })
    else environmentMocks.detectSystemEnvironment.mockRejectedValue(new Error('Detection failed'))
    render(<EnvironmentSettingsHarness initialSettings={appSettings({ customInformation: 'Keep this information' })} onSaveSettings={onSaveSettings} />)
    const input = screen.getByRole('textbox', { name: 'settings.custom_environment_information' })
    await user.click(input)
    await user.keyboard('{Control>}a{/Control}')
    await user.click(screen.getByRole('button', { name: 'settings.detect_system_environment' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.detect_system_environment' })).toBeEnabled())
    expect(input).toHaveValue('Keep this information')
    expect(onSaveSettings).not.toHaveBeenCalled()
  })

  it('saves a manually edited custom environment value on blur', async () => {
    const user = userEvent.setup()
    const onSaveSettings = vi.fn()
    render(
      <EnvironmentSettingsHarness
        initialSettings={appSettings({ customInformation: 'Existing information.' })}
        onSaveSettings={onSaveSettings}
      />
    )
    const input = screen.getByRole('textbox', {
      name: /settings\.custom_environment_information/
    })

    await user.type(input, ' Manual addition.')
    await user.tab()

    expect(onSaveSettings).toHaveBeenLastCalledWith({
      environmentContext: expect.objectContaining({
        customInformation: 'Existing information. Manual addition.'
      })
    })
  })

  it('preserves an unsaved draft when startup detection updates the saved value', async () => {
    const user = userEvent.setup()
    const onSaveSettings = vi.fn()
    const props = {
      envDraft: '', sectionClass: () => 'environment-section', onAutosizeInput: vi.fn(),
      onOpenEnvFile: vi.fn(), onUpdateEnvDraft: vi.fn(), onSaveSettings
    }
    const { rerender } = render(<EnvironmentSettingsSections {...props} settings={appSettings()} />)
    const input = screen.getByRole('textbox', { name: 'settings.custom_environment_information' })
    await user.type(input, 'My environment')
    rerender(<EnvironmentSettingsSections {...props} settings={appSettings({ customInformation: 'Startup result' })} />)
    expect(input).toHaveValue('My environment')
    await user.tab()
    expect(onSaveSettings).toHaveBeenLastCalledWith({
      environmentContext: expect.objectContaining({ customInformation: 'My environment' })
    })
  })
})

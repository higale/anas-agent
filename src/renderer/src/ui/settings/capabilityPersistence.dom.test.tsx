import { useState } from 'react'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import type { AppConfigSnapshot, AppProfileUpdate, AppSettings } from '@shared/types'
import { defaultCapabilitySettings, type DefaultCapabilitySettings } from '@shared/agentCapabilities'
import { environmentContextFixture } from '../../../../test/environmentContextFixture'
import { CapabilitySettings } from './CapabilitySettings'
import { EnvironmentSettingsSections } from './EnvironmentSettingsSections'
import { useSettingsController } from './useSettingsController'
import { notice } from '../notice'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../i18n', () => ({ applyLanguagePreference: vi.fn() }))
vi.mock('../notice', () => ({ notice: { error: vi.fn(), dismiss: vi.fn() } }))
const t = ((key: string) => key) as TFunction

function initialConfig(): AppConfigSnapshot {
  return {
    customTools: [], defaultCapabilities: structuredClone(defaultCapabilitySettings), subagents: [], mcpServers: [], providers: [],
    settings: {
      fontSize: 14, theme: 'dark', environmentContext: environmentContextFixture(),
      speechReply: { enabled: true, voice: 'voice', speed: 1 },
      profile: { assistant: { name: 'Anas', role: '', instructions: '', newAvatarPath: '' }, user: { preferredName: '', personalInfo: '' } }
    } as AppSettings
  }
}

function useController() {
  const [config, setConfig] = useState<AppConfigSnapshot | undefined>(initialConfig)
  return useSettingsController({ config, setConfig, t })
}

function Harness() {
  const controller = useController()
  return <>
    <button onClick={() => controller.setSettingsOpen(!controller.settingsOpen)}>Toggle settings</button>
    {controller.settingsOpen && <>
      <CapabilitySettings config={controller.config!} onSave={controller.saveDefaultCapabilities} />
      <EnvironmentSettingsSections envDraft="" settings={controller.config?.settings} sectionClass={() => ''}
        onAutosizeInput={() => {}} onOpenEnvFile={() => {}} onUpdateEnvDraft={() => {}} onSaveSettings={controller.saveSettings} />
    </>}
  </>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('settings autosave', () => {
  it('rejects an empty assistant name without poisoning later valid profile edits', async () => {
    const updateProfile = vi.fn(async (update: AppProfileUpdate) => {
      if (update.assistant?.name !== undefined && !update.assistant.name.trim()) throw new Error('Empty name')
      const config = initialConfig()
      return { ...config, settings: { ...config.settings, profile: {
        assistant: { ...config.settings.profile.assistant, ...update.assistant },
        user: { ...config.settings.profile.user, ...update.user }
      } } }
    })
    vi.stubGlobal('gale', { config: { updateProfile } })
    const { result } = renderHook(useController)
    await act(async () => result.current.saveProfile({ assistant: { name: '  ' } }))
    expect(updateProfile).not.toHaveBeenCalled()
    expect(notice.error).toHaveBeenCalledWith('settings.assistant_name_required')
    await act(async () => result.current.saveProfile({ user: { preferredName: 'Gale' } }))
    expect(updateProfile).toHaveBeenCalledOnce()
    expect(result.current.config?.settings.profile.user.preferredName).toBe('Gale')
    expect(result.current.config?.settings.profile.assistant.name).toBe('Anas')
  })

  it('keeps capability edits enabled across page changes and serializes every choice', async () => {
    const first = deferred<AppConfigSnapshot>()
    const second = deferred<AppConfigSnapshot>()
    const save = vi.fn<(value: DefaultCapabilitySettings) => Promise<AppConfigSnapshot>>()
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal('gale', { config: { saveDefaultCapabilities: save } })
    render(<Harness />)
    const toggle = screen.getByRole('button', { name: 'Toggle settings' })
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_profile' }))
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    const profile = screen.getByRole('checkbox', { name: 'settings.capability_profile' })
    expect(profile).not.toBeChecked()
    expect(profile).toBeEnabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_workspaceContext' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    await act(async () => first.resolve({ ...initialConfig(), defaultCapabilities: save.mock.calls[0][0] }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[1][0].capabilities).toMatchObject({ profile: false, workspace: false })
    expect(screen.getByRole('checkbox', { name: 'settings.capability_workspaceContext' })).not.toBeChecked()
    await act(async () => second.resolve({ ...initialConfig(), defaultCapabilities: save.mock.calls[1][0] }))
    expect(profile).not.toBeChecked()
  })

  it('retains failed edits after closing and retries the current draft', async () => {
    const first = deferred<AppConfigSnapshot>()
    const save = vi.fn<(value: DefaultCapabilitySettings) => Promise<AppConfigSnapshot>>()
      .mockReturnValueOnce(first.promise).mockImplementation(async (value) => ({ ...initialConfig(), defaultCapabilities: value }))
    vi.stubGlobal('gale', { config: { saveDefaultCapabilities: save } })
    render(<Harness />)
    const toggle = screen.getByRole('button', { name: 'Toggle settings' })
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_profile' }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    fireEvent.click(toggle)
    await act(async () => first.reject(new Error('Disk write failed')))
    expect(notice.error).toHaveBeenCalledWith('chat.failed_save_settings', expect.objectContaining({ action: expect.any(Object) }))
    fireEvent.click(toggle)
    expect(screen.getByRole('checkbox', { name: 'settings.capability_profile' })).not.toBeChecked()
    const options = vi.mocked(notice.error).mock.calls[0][1]!
    await act(async () => { (options.action as unknown as { onClick: () => void }).onClick() })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[1][0].capabilities.profile).toBe(false)
  })

  it('combines rapid environment changes without old responses reverting them', async () => {
    const first = deferred<AppConfigSnapshot>()
    const save = vi.fn<(patch: Partial<AppSettings>) => Promise<AppConfigSnapshot>>()
      .mockReturnValueOnce(first.promise).mockImplementation(async (patch) => ({ ...initialConfig(), settings: { ...initialConfig().settings, ...patch } }))
    vi.stubGlobal('gale', { config: { updateSettings: save } })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle settings' }))
    const os = screen.getByRole('checkbox', { name: 'settings.capability_operatingSystem' })
    const date = screen.getByRole('checkbox', { name: 'settings.capability_currentDate' })
    fireEvent.click(os)
    fireEvent.click(date)
    expect(os).not.toBeChecked()
    expect(date).not.toBeChecked()
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    await act(async () => first.resolve({ ...initialConfig(), settings: { ...initialConfig().settings, ...save.mock.calls[0][0] } }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[1][0].environmentContext).toMatchObject({ operatingSystem: false, currentDate: false })
    expect(os).not.toBeChecked()
    expect(date).not.toBeChecked()
  })

  it('keeps general, profile and speech drafts when independent saves finish out of order', async () => {
    const settings = deferred<AppConfigSnapshot>()
    const speech = deferred<AppConfigSnapshot>()
    const profile = deferred<AppConfigSnapshot>()
    vi.stubGlobal('gale', { config: {
      updateSettings: vi.fn().mockReturnValueOnce(settings.promise).mockImplementation(async (patch: Partial<AppSettings>) => ({ ...initialConfig(), settings: { ...initialConfig().settings, ...patch } })),
      updateSpeechReply: vi.fn().mockReturnValue(speech.promise), updateProfile: vi.fn().mockReturnValue(profile.promise)
    } })
    const { result } = renderHook(useController)
    act(() => { void result.current.saveSettings({ fontSize: 15 }); void result.current.saveSettings({ fontSize: 18 }) })
    act(() => { void result.current.saveSpeechReply({ speed: 1.5 }); void result.current.saveProfile({ user: { preferredName: 'Gale' } }) })
    expect(result.current.config?.settings.fontSize).toBe(18)
    expect(result.current.config?.settings.speechReply.speed).toBe(1.5)
    await act(async () => speech.resolve({ ...initialConfig(), settings: { ...initialConfig().settings, speechReply: { enabled: true, voice: 'voice', speed: 1.5 } } }))
    await act(async () => settings.resolve({ ...initialConfig(), settings: { ...initialConfig().settings, fontSize: 15 } }))
    await act(async () => profile.resolve({ ...initialConfig(), settings: { ...initialConfig().settings, profile: { ...initialConfig().settings.profile, user: { preferredName: 'Gale', personalInfo: '' } } } }))
    expect(result.current.config?.settings.fontSize).toBe(18)
    expect(result.current.config?.settings.speechReply.speed).toBe(1.5)
    expect(result.current.config?.settings.profile.user.preferredName).toBe('Gale')
  })
})

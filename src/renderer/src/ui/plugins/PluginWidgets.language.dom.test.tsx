import { act, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { PluginSummary } from '@shared/plugins'
import type { ResolvedModelConfig } from '@shared/types'
import { applyLanguagePreference, initializeI18nFromResources } from '../../i18n'
import { PluginWidgets } from './PluginWidgets'

it('keeps widget content on same-language settings saves and refreshes when the language changes', async () => {
  await initializeI18nFromResources({
    langDir: '', languages: [
      { code: 'en', name: 'English', builtIn: true },
      { code: 'zh-CN', name: '简体中文', builtIn: true }
    ],
    resources: {
      en: { common: { loading: 'Loading' } },
      'zh-CN': { common: { loading: '加载中' } }
    }
  }, 'en')
  const content = { title: 'Usage', html: '<p>68%</p>' }
  const readWidget = vi.fn(async () => content)
  Object.defineProperty(window, 'gale', { configurable: true, value: { plugins: { readWidget } } })
  const plugins = [{ id: 'usage', enabled: true, backendStatus: 'running', manifest: { name: 'Usage', widgets: [
    { id: 'quota', location: 'sidebar.footer', handler: 'quota', actions: ['refresh'], modelHosts: ['api.minimaxi.com'] }
  ] } }] as PluginSummary[]
  const model = { id: 'first', model: 'model', baseUrl: 'https://api.minimaxi.com/v1', apiKey: 'test-only' } as ResolvedModelConfig
  const { rerender } = render(<PluginWidgets plugins={plugins} model={model} active />)
  await waitFor(() => expect(screen.getByRole('region')).toHaveAttribute('aria-busy', 'false'))
  const reading = document.querySelector('.plugin-widget-html')!.shadowRoot!.querySelector('p')!
  expect(reading).toHaveTextContent('68%')
  expect(readWidget).toHaveBeenCalledTimes(1)

  await act(async () => {
    rerender(<PluginWidgets plugins={plugins} model={{ ...model }} active />)
    await applyLanguagePreference('en')
    await applyLanguagePreference('en')
  })
  expect(readWidget).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('region')).toHaveAttribute('aria-busy', 'false')
  expect(reading.isConnected).toBe(true)

  let complete!: (value: typeof content) => void
  readWidget.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  await act(async () => { await applyLanguagePreference('zh-CN') })
  expect(readWidget).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('status')).toHaveTextContent('加载中')
  await act(async () => { complete({ title: '用量', html: '<p>剩余 68%</p>' }) })
  expect(screen.getByRole('region', { name: '用量' })).toHaveAttribute('aria-busy', 'false')
  expect(document.querySelector('.plugin-widget-html')!.shadowRoot!.querySelector('p')).toHaveTextContent('剩余 68%')
})

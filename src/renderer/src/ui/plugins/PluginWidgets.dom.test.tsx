import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import type { PluginSummary } from '@shared/plugins'
import type { ResolvedModelConfig } from '@shared/types'
import { PluginWidgets } from './PluginWidgets'
import { parseWidgetHtml } from './PluginWidgetHtml'

const mocks = vi.hoisted(() => ({ read: vi.fn(), open: vi.fn(), t: (key: string, options?: { name?: string }) => options?.name ? `${key}:${options.name}` : key }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t, i18n: { language: 'en' } }) }))
const plugins = [{ id: 'usage', enabled: true, backendStatus: 'running', manifest: { name: 'Usage', widgets: [
  { id: 'quota', location: 'sidebar.footer', handler: 'quota', actions: ['refresh'], modelHosts: ['api.minimaxi.com'] }
] } }] as PluginSummary[]
const model = { id: 'first', model: 'MiniMax-M2.7', baseUrl: 'https://api.minimaxi.com/v1', apiKey: 'secret' } as ResolvedModelConfig
const content = { title: 'MiniMax', html: '<div class="ui-stack"><p>68%</p><p title="Exact reset time">Resets in 1h</p><button data-action="refresh"><span>Refresh now</span></button></div>' }
const root = () => document.querySelector('.plugin-widget-html')!.shadowRoot!
const widget = () => within(root() as unknown as HTMLElement)
const ready = () => waitFor(() => expect(widget().getByText('68%')).toBeVisible())
beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue(content)
  mocks.open.mockReset().mockResolvedValue('opened')
  Object.defineProperty(window, 'gale', { configurable: true, value: { plugins: { readWidget: mocks.read }, app: { openExternalUrl: mocks.open } } })
})

it('renders plugin HTML in a shadow root and bridges nested action clicks without duplicate calls', async () => {
  render(<PluginWidgets plugins={plugins} model={model} active />)
  await ready()
  expect(widget().getByText('Resets in 1h')).toHaveAttribute('data-tooltip', 'Exact reset time')
  expect(screen.queryByText('68%')).not.toBeInTheDocument()
  let complete!: (value: unknown) => void
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  fireEvent.click(widget().getByText('Refresh now'))
  expect(widget().getByText('68%')).toBeVisible()
  expect(screen.queryByText(/common.loading/)).not.toBeInTheDocument()
  expect(widget().getByRole('button', { name: 'Refresh now' })).toBeDisabled()
  fireEvent.click(widget().getByText('Refresh now'))
  expect(mocks.read).toHaveBeenCalledTimes(2)
  expect(mocks.read).toHaveBeenLastCalledWith('usage', 'quota', 'first', 'refresh')
  await act(async () => { complete({ ...content, html: content.html.replace('68%', '60%') }) })
  expect(widget().getByText('60%')).toBeVisible()
  expect(widget().getByRole('button', { name: 'Refresh now' })).toBeEnabled()
})

it('identifies missing credential variables without displaying other backend diagnostics', async () => {
  mocks.read.mockRejectedValueOnce(new Error("Error invoking remote method 'plugins:readWidget': Error: API key environment variable MY_TOKEN is missing or empty."))
  render(<PluginWidgets plugins={plugins} model={{ ...model, apiKey: '${MY_TOKEN}' }} active />)
  expect(await screen.findByText('settings.api_key_variable_missing:MY_TOKEN')).toBeVisible()
  expect(screen.queryByText(/Error invoking/)).not.toBeInTheDocument()
})

it('shows a loading state before the first supported query finishes', async () => {
  let complete!: (value: unknown) => void
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  render(<PluginWidgets plugins={plugins} model={model} active />)
  expect(screen.getByRole('region', { name: 'Usage' })).toHaveAttribute('aria-busy', 'true')
  expect(screen.getByRole('status')).toHaveTextContent('common.loading')
  expect(document.querySelector('.plugin-widget-html')).toBeNull()
  await act(async () => { complete(content) })
  await ready()
  expect(screen.queryByText(/common.loading/)).not.toBeInTheDocument()
})

it('hides unsupported, disabled and inactive contributions without querying', () => {
  const { rerender, container } = render(<PluginWidgets plugins={plugins} model={{ ...model, baseUrl: 'https://other.test' }} active />)
  expect(container).toBeEmptyDOMElement()
  rerender(<PluginWidgets plugins={plugins.map(p => ({ ...p, enabled: false }))} model={model} active />)
  rerender(<PluginWidgets plugins={plugins} model={model} active={false} />)
  expect(mocks.read).not.toHaveBeenCalled()
})

it('ignores old responses after selection changes, and never sends credentials over renderer IPC', async () => {
  let complete!: (value: unknown) => void, completeNext!: (value: unknown) => void
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { completeNext = resolve }))
  const { rerender } = render(<PluginWidgets plugins={plugins} model={model} active />)
  rerender(<PluginWidgets plugins={plugins} model={{ ...model, id: 'second' }} active />)
  expect(screen.getByRole('status')).toHaveTextContent('common.loading')
  await act(async () => { complete({ title: 'Old', html: '<p>old reading</p>' }) })
  expect(screen.getByRole('status')).toHaveTextContent('common.loading')
  expect(document.querySelector('.plugin-widget-html')).toBeNull()
  await act(async () => { completeNext(content) })
  await ready()
  expect(widget().queryByText('old reading')).not.toBeInTheDocument()
  expect(mocks.read.mock.calls).toEqual([['usage', 'quota', 'first', undefined], ['usage', 'quota', 'second', undefined]])
})

it.each([{ id: 'second' }, { apiKey: 'changed-secret' }])('clears previous readings while the changed context loads: %j', async changes => {
  const { rerender } = render(<PluginWidgets plugins={plugins} model={model} active />)
  await ready()
  let complete!: (value: unknown) => void
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  rerender(<PluginWidgets plugins={plugins} model={{ ...model, ...changes }} active />)
  expect(screen.getByRole('status')).toHaveTextContent('common.loading')
  expect(document.querySelector('.plugin-widget-html')).toBeNull()
  await act(async () => { complete({ ...content, html: '<p>new reading</p>' }) })
  expect(widget().getByText('new reading')).toBeVisible()
})

it('replaces an initial failure with loading on retry and then shows the result', async () => {
  mocks.read.mockRejectedValueOnce(new Error('secret'))
  render(<PluginWidgets plugins={plugins} model={model} active />)
  await screen.findByText('plugins.widget_failed')
  expect(screen.queryByText('secret')).not.toBeInTheDocument()
  let complete!: (value: unknown) => void
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }))
  expect(screen.getByRole('status')).toHaveTextContent('common.loading')
  await act(async () => { complete(content) })
  await ready()
})

it('keeps an explicitly hidden result hidden while checking again', async () => {
  mocks.read.mockResolvedValueOnce(null)
  const { container } = render(<PluginWidgets plugins={plugins} model={model} active />)
  await waitFor(() => expect(container).toBeEmptyDOMElement())
  let complete!: (value: unknown) => void
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  fireEvent.focus(window)
  expect(mocks.read).toHaveBeenCalledTimes(2)
  expect(container).toBeEmptyDOMElement()
  await act(async () => { complete(content) })
  await ready()
})

it('retains the previous HTML on transport failure and hides a stopped backend result', async () => {
  const { rerender } = render(<PluginWidgets plugins={plugins} model={model} active />)
  await ready()
  mocks.read.mockRejectedValueOnce(new Error('secret'))
  fireEvent.click(widget().getByRole('button', { name: 'Refresh now' }))
  await screen.findByText('plugins.widget_failed')
  expect(widget().getByText('68%')).toBeVisible()
  expect(screen.queryByText('secret')).not.toBeInTheDocument()
  mocks.read.mockResolvedValueOnce(null)
  rerender(<PluginWidgets plugins={plugins.map(p => ({ ...p, backendStatus: 'stopped' }))} model={model} active />)
  await waitFor(() => expect(document.querySelector('.plugin-widget-html')).toBeNull())
})

it('supports tables, details, package images, host controls, and external links without a fixed row schema', async () => {
  mocks.read.mockResolvedValueOnce({ title: 'Custom layout', html: `<details open><summary>Plan</summary>
    <table><tr><th>Expires</th><td>2026-12-31</td></tr></table></details>
    <img src="assets/meter.svg" alt="Plan icon"><a href="https://example.com/plan">Manage plan</a>
    <button data-action="refresh" disabled>Unavailable</button>` })
  render(<PluginWidgets plugins={plugins} model={model} active />)
  await waitFor(() => expect(widget().getByRole('table')).toBeVisible())
  expect(widget().getByRole('cell')).toHaveTextContent('2026-12-31')
  expect(widget().getByRole('img')).toHaveAttribute('src', 'anas-plugin://usage/_anas/icon/assets/meter.svg')
  expect(widget().getByRole('button')).toHaveClass('ui-button')
  expect(widget().getByRole('button')).toBeDisabled()
  fireEvent.click(widget().getByRole('link'))
  expect(mocks.open).toHaveBeenCalledWith('https://example.com/plan')
})

it('reports invalid HTML without replacing the last valid snapshot', async () => {
  render(<PluginWidgets plugins={plugins} model={model} active />)
  await ready()
  mocks.read.mockResolvedValueOnce({ title: 'Bad CSS', html: '<p style="color:red">Override</p>' })
  fireEvent.click(widget().getByRole('button', { name: 'Refresh now' }))
  await screen.findByText('plugins.widget_invalid_html')
  expect(widget().getByText('68%')).toBeVisible()
  expect(widget().queryByText('Override')).not.toBeInTheDocument()
})

it.each([false, true])('opens local details (icon: %s) without backend calls, even during refresh, and removes stale details', async icon => {
  const user = userEvent.setup()
  mocks.read.mockResolvedValueOnce({ ...content, html: content.html + (icon
    ? '<button class="ui-tool-button" aria-label="Details" data-details="Status: Active"><img src="assets/info.svg" alt=""></button>'
    : '<button class="ui-link-button" data-details="Status: Active">Details</button>') })
  const { rerender } = render(<><button>Outside widget</button><PluginWidgets plugins={plugins} model={model} active /></>)
  await ready()
  const trigger = widget().getByRole('button', { name: 'Details' })
  if (icon) expect(trigger.querySelector('img')?.src).toBe('anas-plugin://usage/_anas/icon/assets/info.svg')
  await user.hover(screen.getByRole('button', { name: 'Outside widget' }))
  await user.hover(trigger.querySelector('img') ?? trigger)
  await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Status: Active'))
  await user.click(trigger)
  expect(screen.getByRole('dialog')).toHaveTextContent('Status: Active')
  await user.click(trigger)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await user.click(trigger)
  expect(screen.getByRole('dialog')).toHaveTextContent('Status: Active')
  expect(mocks.read).toHaveBeenCalledTimes(1)
  let complete!: (value: unknown) => void
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  fireEvent.click(widget().getByRole('button', { name: 'Refresh now' }))
  expect(trigger).toBeEnabled()
  await act(async () => { complete(content) })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(widget().queryByRole('button', { name: 'Details' })).not.toBeInTheDocument()
  rerender(<PluginWidgets plugins={plugins} model={model} active={false} />)
  expect(document.querySelector('.ui-details-popover')).toBeNull()
})

it('enforces host CSS and declared actions before mounting fragments', () => {
  for (const html of ['<style>body{color:red}</style>', '<script>alert(1)</script>', '<p onclick="x()">Click</p>',
    '<link rel="stylesheet" href="x.css">', '<iframe src="https://example.com"></iframe>', '<button data-action="delete">Delete</button>',
    '<p data-action="refresh">Refresh</p>', '<a href="javascript:x()">Click</a>', '<img src="../outside.svg">',
    '<div data-details="Active">Details</div>', '<button data-details="">Details</button>',
    '<button data-details="Active" data-action="refresh">Details</button>', '<button data-details="Active" title="Another tooltip">Details</button>',
    '<button data-details="Active"><img src="assets/info.svg"></button>',
    '<button data-details="Active" aria-label="Details"><img src="../outside.svg"></button>',
    '<button data-details="Active"><span>Details</span></button>', '<div>'.repeat(1001)]) {
    expect(() => parseWidgetHtml(html, 'usage', ['refresh'])).toThrow()
  }
})

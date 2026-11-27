import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notice } from '../notice'
import { ProjectAppearancePicker } from './ProjectAppearancePicker'
import chinese from '../../../../../data/lang/zh-CN.json'
import english from '../../../../../data/lang/en.json'
import { PROJECT_ICON_NAMES } from '@shared/projectAppearance'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { lng?: string }) => {
  const names = (options?.lng === 'en' ? english : chinese).project.icon_names
  return key.startsWith('project.icon_names.') ? names[key.slice('project.icon_names.'.length) as keyof typeof names] : key
}, i18n: { language: 'zh-CN' } }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10"/></svg>'
const svgData = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
const decode = vi.fn<() => Promise<void>>()
const imageDrop = () => ({ dataTransfer: { types: ['Files'], files: [new File([svg], 'icon.svg', { type: 'image/svg+xml' })] } })
const props = () => ({ disabled: false, onPendingChange: vi.fn(), onChangeImage: vi.fn(), onChangeEmoji: vi.fn(), onChangeColor: vi.fn(), onChangeIcon: vi.fn() })

beforeEach(() => {
  decode.mockResolvedValue(undefined)
  vi.stubGlobal('Image', class {
    naturalWidth = 24
    naturalHeight = 24
    src = ''
    decode = decode
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('project icon drag and drop', () => {
  it('searches emoji by Chinese, English and emoji characters without submitting the form', async () => {
    const callbacks = props()
    const submit = vi.fn(event => event.preventDefault())
    render(<form onSubmit={submit}><ProjectAppearancePicker {...callbacks} iconData={svgData} /></form>)
    fireEvent.click(screen.getByRole('button', { name: 'project.choose_icon' }))
    fireEvent.click(screen.getByRole('radio', { name: 'project.emoji' }))
    await screen.findByRole('button', { name: '旅行与地点' })
    const search = screen.getByRole('searchbox', { name: 'project.search_emoji' })
    for (const query of ['火箭', 'rocket', '🚀']) {
      fireEvent.change(search, { target: { value: query } })
      expect(screen.getByRole('button', { name: '🚀 火箭' })).toBeVisible()
    }
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '🚀 火箭' }))
    expect(callbacks.onChangeEmoji).toHaveBeenLastCalledWith('🚀')
    expect(callbacks.onChangeImage).toHaveBeenLastCalledWith(undefined)
    fireEvent.change(search, { target: { value: 'no-such-emoji-123456' } })
    expect(screen.getByRole('status')).toHaveTextContent('project.emoji_no_results')
  })

  it('opens the selected emoji category and switches back to the single-page icon grid', async () => {
    const callbacks = props()
    render(<ProjectAppearancePicker {...callbacks} emoji="🚀" />)
    fireEvent.click(screen.getByRole('button', { name: 'project.choose_icon' }))
    expect(await screen.findByRole('button', { name: '旅行与地点' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '🚀 火箭' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '动物与自然' }))
    expect(screen.getByRole('button', { name: '动物与自然' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: '🚀 火箭' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'project.icon_tab' }))
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    const icons = screen.getAllByRole('button', { name: 'project.icon_option' })
    expect(icons).toHaveLength(PROJECT_ICON_NAMES.length)
    fireEvent.click(icons[PROJECT_ICON_NAMES.indexOf('braces')])
    expect(callbacks.onChangeEmoji).toHaveBeenLastCalledWith(undefined)
    expect(callbacks.onChangeIcon).toHaveBeenLastCalledWith('braces')
  })

  it('replaces an emoji with a directly dropped image', async () => {
    const callbacks = props()
    render(<ProjectAppearancePicker {...callbacks} emoji="🚀" />)
    fireEvent.drop(screen.getByRole('button', { name: 'project.choose_icon' }), imageDrop())
    await waitFor(() => expect(callbacks.onChangeImage).toHaveBeenCalledWith(svgData))
    expect(callbacks.onChangeEmoji).toHaveBeenLastCalledWith(undefined)
  })

  it('keeps the newly chosen emoji when an earlier image drop finishes later', async () => {
    let finish!: () => void
    decode.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const callbacks = props()
    render(<ProjectAppearancePicker {...callbacks} />)
    const trigger = screen.getByRole('button', { name: 'project.choose_icon' })
    fireEvent.drop(trigger, imageDrop())
    await waitFor(() => expect(decode).toHaveBeenCalledOnce())
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('radio', { name: 'project.emoji' }))
    const search = screen.getByRole('searchbox', { name: 'project.search_emoji' })
    fireEvent.change(search, { target: { value: 'rocket' } })
    fireEvent.click(await screen.findByRole('button', { name: '🚀 火箭' }))
    await act(async () => { finish() })
    expect(callbacks.onChangeEmoji).toHaveBeenCalledExactlyOnceWith('🚀')
    expect(callbacks.onChangeImage).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(callbacks.onPendingChange).toHaveBeenLastCalledWith(false)
  })

  it('keeps a single tab stop in each grid and supports arrow navigation', () => {
    render(<ProjectAppearancePicker {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'project.choose_icon' }))
    const options = screen.getAllByRole('button', { name: 'project.icon_option' })
    expect(options.filter(option => option.tabIndex === 0)).toHaveLength(1)
    act(() => options[0].focus())
    fireEvent.keyDown(options[0], { key: 'ArrowDown' })
    expect(options[8]).toHaveFocus()
    expect(options.filter(option => option.tabIndex === 0)).toEqual([options[8]])
    fireEvent.keyDown(options[8], { key: 'End' })
    expect(options.at(-1)).toHaveFocus()
  })

  it('imports directly onto the closed picker and keeps click-to-select available', async () => {
    const callbacks = props()
    const view = render(<ProjectAppearancePicker {...callbacks} />)
    const trigger = screen.getByRole('button', { name: 'project.choose_icon' })
    fireEvent.dragOver(trigger, imageDrop())
    fireEvent.drop(trigger.querySelector('svg')!, imageDrop())
    expect(callbacks.onPendingChange).toHaveBeenLastCalledWith(true)
    await waitFor(() => expect(callbacks.onChangeImage).toHaveBeenCalledWith(svgData))
    expect(callbacks.onPendingChange).toHaveBeenLastCalledWith(false)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    view.rerender(<ProjectAppearancePicker {...callbacks} iconData={svgData} />)
    expect(trigger.querySelector('img')).toHaveAttribute('src', svgData)

    fireEvent.click(trigger)
    expect(screen.getByRole('button', { name: 'project.upload_icon' })).toBeVisible()
    fireEvent.click(screen.getAllByRole('button', { name: 'project.icon_option' })[0])
    expect(callbacks.onChangeImage).toHaveBeenLastCalledWith(undefined)
    expect(callbacks.onChangeIcon).toHaveBeenCalledOnce()
  })

  it('reports an unsupported file without replacing the current icon', async () => {
    const callbacks = props()
    render(<ProjectAppearancePicker {...callbacks} iconData={svgData} />)
    const trigger = screen.getByRole('button', { name: 'project.choose_icon' })
    fireEvent.drop(trigger.querySelector('img')!, { dataTransfer: { files: [new File(['text'], 'notes.txt')] } })
    await waitFor(() => expect(notice.error).toHaveBeenCalledWith('settings.image_icon_unsupported_type'))
    expect(callbacks.onChangeImage).not.toHaveBeenCalled()
    expect(callbacks.onPendingChange).toHaveBeenLastCalledWith(false)
    expect(trigger.querySelector('img')).toHaveAttribute('src', svgData)
  })

  it('rejects drops while project saving disables the picker', () => {
    const callbacks = props()
    render(<ProjectAppearancePicker {...callbacks} disabled />)
    const trigger = screen.getByRole('button', { name: 'project.choose_icon' })
    const event = imageDrop()
    fireEvent.dragOver(trigger, event)
    expect(event.dataTransfer).toHaveProperty('dropEffect', 'none')
    expect(fireEvent.drop(trigger, event)).toBe(false)
    expect(callbacks.onPendingChange).not.toHaveBeenCalled()
    expect(callbacks.onChangeImage).not.toHaveBeenCalled()
  })

  it('does not overwrite a built-in selection when an earlier drop finishes decoding', async () => {
    let finish!: () => void
    decode.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const callbacks = props()
    render(<ProjectAppearancePicker {...callbacks} />)
    const trigger = screen.getByRole('button', { name: 'project.choose_icon' })
    fireEvent.drop(trigger, imageDrop())
    await waitFor(() => expect(decode).toHaveBeenCalledOnce())
    fireEvent.click(trigger)
    fireEvent.click(screen.getAllByRole('button', { name: 'project.icon_option' })[0])
    await act(async () => { finish() })
    expect(callbacks.onChangeImage).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(callbacks.onPendingChange).toHaveBeenLastCalledWith(false)
  })
})

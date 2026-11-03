import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { MemorySettings } from './MemorySettings'
import { PreferenceMemoryDocument } from '../PreferenceMemoryDocument'
import { PanelViewState } from '../agent/PanelViewState'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
vi.mock('../CodeFileEditor', () => ({ CodeFileEditor: ({ content, onChange }: { content: string; onChange?(text: string): void }) =>
  onChange ? <textarea defaultValue={content} onChange={event => onChange(event.target.value)} /> : <pre>{content}</pre> }))

it('renders project Markdown and its editable source', async () => {
  const content = '---\n\n# Project conventions\n\n- **Use TypeScript**\n\n---\n'
  const read = vi.fn(async () => ({ path: '/example/db/projects/demo/MEMORY.md', content, hash: 'project' }))
  Object.defineProperty(window, 'gale', { configurable: true, value: { preferences: { read, onChanged: () => () => {} } } })
  render(<PreferenceMemoryDocument projectId="demo" />)
  expect(await screen.findByRole('heading', { name: 'Project conventions' })).toBeVisible()
  expect(read).toHaveBeenCalledWith({ kind: 'project', projectId: 'demo' })
  fireEvent.click(screen.getByRole('radio', { name: 'settings.file_source' }))
  expect(screen.getByText(content.trim(), { normalizer: text => text.trim() })).toBeVisible()
  expect(screen.getByRole('button', { name: 'common.edit' })).toBeEnabled()
})

it('preserves a global draft while a background publication changes the base', async () => {
  let changed!: () => void
  const file = { scope: { kind: 'global' }, path: '/example/db/MEMORY.md' }
  const read = vi.fn(async () => ({ ...file, content: '- 中文回答', hash: 'first' }))
  const unsubscribe = vi.fn()
  const save = vi.fn(async () => ({ status: 'saved', document: { ...file, content: '- My edit', hash: 'saved' } }))
  Object.defineProperty(window, 'gale', { configurable: true, value: { preferences: { read, save,
    onChanged: (listener: () => void) => { changed = listener; return unsubscribe } } } })
  const view = render(<MemorySettings sectionClass="settings-section" />)
  expect(await screen.findByRole('listitem')).toHaveTextContent('中文回答')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByText('common.save')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'common.edit' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '- My edit' } })
  read.mockResolvedValue({ ...file, content: '- 简短回答', hash: 'new' })
  await act(async () => { changed() })
  expect(await screen.findByText('- 简短回答')).toBeTruthy()
  expect(screen.getByRole('textbox')).toHaveValue('- My edit')
  expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'settings.memory_reviewed' }))
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
  expect(await screen.findByText('My edit', { selector: 'li' })).toBeVisible()
  expect(save).toHaveBeenCalledWith({ kind: 'global' }, 'new', '- My edit')
  view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce()
})

it('finishes a pending global save after navigating away without reopening a stale draft', async () => {
  const state = new Map<string, unknown>()
  const file = { scope: { kind: 'global' }, path: '/db/MEMORY.md', content: 'Original', hash: 'first' }
  let finish!: () => void
  const save = vi.fn(async () => {
    await new Promise<void>(resolve => { finish = resolve })
    file.content = 'Saved'; file.hash = 'second'
    return { status: 'saved', document: { ...file } }
  })
  Object.defineProperty(window, 'gale', { configurable: true, value: { preferences: {
    read: async () => ({ ...file }), save, onChanged: () => () => {}
  } } })
  const page = () => <PanelViewState state={state}><PreferenceMemoryDocument /></PanelViewState>
  const first = render(page())
  fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Saved' } })
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
  first.unmount()
  await act(async () => finish())
  render(page())
  expect(await screen.findByText('Saved')).toBeVisible()
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('shows the latest publication when its notification arrives before an older save response', async () => {
  const file = { scope: { kind: 'global' }, path: '/db/MEMORY.md', content: 'Original', hash: 'first' }
  let changed!: () => void, finish!: () => void
  const save = vi.fn(async () => {
    await new Promise<void>(resolve => { finish = resolve })
    return { status: 'saved', document: { ...file, content: 'User edit', hash: 'second' } }
  })
  Object.defineProperty(window, 'gale', { configurable: true, value: { preferences: {
    read: async () => ({ ...file }), save, onChanged: (notify: () => void) => { changed = notify; return () => {} }
  } } })
  render(<PreferenceMemoryDocument />)
  fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'User edit' } })
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
  file.content = 'Newer publication'; file.hash = 'third'
  await act(async () => changed())
  await act(async () => finish())
  expect(await screen.findByText('Newer publication')).toBeVisible()
  expect(screen.queryByRole('textbox')).toBeNull()
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PackageFileViewer } from './PackageTree'
import type { PackageFilePreview } from '@shared/packageFiles'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../CodeFileEditor', () => ({ CodeFileEditor: ({ content, onChange }: {content: string; onChange?(s: string): void}) => onChange
  ? <textarea aria-label="Code" defaultValue={content} onChange={event => onChange(event.target.value)} />
  : <pre>{content}</pre> }))
const preview: PackageFilePreview = { path:'/tools/example/run.py', resolvedPath:'/tools/example/run.py', relativePath:'run.py', name:'run.py', kind:'text', size:8, content:'print(1)', revision:'original', editable:true }
const props = { preview, t:(key: string) => key, onOpen: vi.fn() }
describe('package file editing', () => {
  it('opens files from the path title and keeps broken symlink titles disabled', async () => {
    const onOpen = vi.fn()
    const view = render(<PackageFileViewer {...props} preview={{ ...preview, relativePath: 'scripts/run.py' }} onOpen={onOpen} />)
    expect(screen.queryByRole('button', { name: 'common.open' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'scripts/run.py' }))
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(preview.path)
    view.rerender(<PackageFileViewer {...props} preview={undefined} file={{ name: 'missing.py', path: '/tools/missing.py', relativePath: 'missing.py', kind: 'symlink' }} onOpen={onOpen} />)
    expect(screen.getByRole('button', { name: 'missing.py' })).toBeDisabled()
  })
  it('previews Markdown with folded metadata and preserves the complete source for editing', async () => {
    const content = '---\nname: demo\ndescription: Demo skill\n---\n# Guide\n\n**Bold**\n\n| A | B |\n|---|---|\n| one | two |'
    const md = { ...preview, name: 'SKILL.md', path: '/tools/example/SKILL.md', content }
    render(<PackageFileViewer {...props} preview={md} onSave={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Guide' })).toBeVisible()
    expect(screen.getByRole('table')).toBeVisible()
    expect(screen.getByText('name: demo', { exact: false })).not.toBeVisible()
    await userEvent.click(screen.getByText('settings.file_metadata'))
    expect(screen.getByText('name: demo', { exact: false })).toBeVisible()
    expect(screen.getByRole('radio', { name: 'settings.file_preview' })).toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: 'settings.file_source' }))
    expect(screen.getByRole('radio', { name: 'settings.file_source' })).toBeChecked()
    expect(screen.queryByRole('heading', { name: 'Guide' })).not.toBeInTheDocument()
    expect(screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === content)).toBeVisible()
    await userEvent.click(screen.getByRole('radio', { name: 'settings.file_preview' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.edit' }))
    expect(screen.getByRole('textbox', { name: 'Code' })).toHaveValue(content)
  })

  it('jumps to a Markdown heading without mistaking later separators for front matter', async () => {
    const content = '[Part](#part)\n\n---\ntext\n---\n\n## Part'
    render(<PackageFileViewer {...props} preview={{ ...preview, name: 'readme.markdown', content }} />)
    const heading = screen.getByRole('heading', { name: 'Part' })
    Object.defineProperty(heading, 'scrollIntoView', { value: vi.fn(), configurable: true })
    await userEvent.click(screen.getByRole('link', { name: 'Part' }))
    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    expect(screen.queryByText('settings.file_metadata')).not.toBeInTheDocument()
  })
  it('saves explicit edits against the displayed file revision', async () => {
    const onSave = vi.fn(async () => {})
    render(<PackageFileViewer {...props} onSave={onSave} />)
    await userEvent.click(screen.getByRole('button',{name:'common.edit'}))
    expect(screen.getByRole('button',{name:'common.save'})).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox',{name:'Code'}),{target:{value:'print(2)'}})
    await userEvent.click(screen.getByRole('button',{name:'common.save'}))
    expect(onSave).toHaveBeenCalledExactlyOnceWith({content:'print(2)',revision:'original',resolvedPath:preview.resolvedPath})
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
  it('keeps the draft on save conflict and asks before discarding', async () => {
    render(<PackageFileViewer {...props} onSave={vi.fn(async () => { throw new Error('Save failed', { cause: new Error('File changed') }) })} />)
    await userEvent.click(screen.getByRole('button',{name:'common.edit'}))
    fireEvent.change(screen.getByRole('textbox',{name:'Code'}),{target:{value:'draft'}})
    await userEvent.click(screen.getByRole('button',{name:'common.save'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('File changed')
    expect(screen.getByRole('alert')).toHaveTextContent('settings.file_save_failed')
    expect(screen.getByRole('textbox',{name:'Code'})).toHaveValue('draft')
    await userEvent.click(screen.getByRole('button',{name:'common.cancel'}))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('settings.file_discard_hint')
    await userEvent.click(screen.getByRole('button',{name:'common.confirm'}))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('does not offer edits for system or binary files', () => {
    const view = render(<PackageFileViewer {...props} preview={{...preview,editable:false}} onSave={vi.fn()} />)
    expect(screen.queryByRole('button',{name:'common.edit'})).not.toBeInTheDocument()
    view.rerender(<PackageFileViewer {...props} preview={{...preview,kind:'binary'}} onSave={vi.fn()} />)
    expect(screen.queryByRole('button',{name:'common.edit'})).not.toBeInTheDocument()
  })
  it('keeps unsaved edits when toggling wrapping and maximizing or restoring', async () => {
    const onSave = vi.fn(async () => {})
    render(<PackageFileViewer {...props} onSave={onSave} />)
    await userEvent.click(screen.getByRole('button', { name: 'common.edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Code' }), { target: { value: 'draft' } })
    const wrap = screen.getByRole('button', { name: 'settings.auto_wrap' })
    expect(wrap).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(wrap)
    expect(wrap).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(screen.getByRole('button', { name: 'settings.file_maximize' }))
    expect(screen.getByRole('button', { name: 'settings.file_restore_size' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'settings.file_restore_size' }))
    expect(screen.getByRole('textbox', { name: 'Code' })).toHaveValue('draft')
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ content: 'draft', revision: 'original', resolvedPath: preview.resolvedPath })
  })
})

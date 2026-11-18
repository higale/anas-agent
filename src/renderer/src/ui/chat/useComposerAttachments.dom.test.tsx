import { useRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import type { SelectedAttachment } from '@shared/types'
import type { ModelImageLimits } from '@shared/modelImageLimits'
import { useComposerDrafts } from './composerDrafts'
import { useComposerAttachments } from './useComposerAttachments'

const notices = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn() }))
vi.mock('../notice', () => ({ notice: notices }))
const t = ((key: string) => key) as TFunction
const files = { openText: vi.fn(), fromDroppedFiles: vi.fn(), releaseTemporaryAttachments: vi.fn(), retainTemporaryAttachment: vi.fn() }
const originalApi = Object.getOwnPropertyDescriptor(window, 'gale')

function file(path: string, kind: SelectedAttachment['kind'] = 'text', extra: Partial<SelectedAttachment> = {}): SelectedAttachment {
  return { path, name: path, kind, mimeType: kind === 'image' ? 'image/png' : 'text/plain', size: 1, contextPolicy: 'one_turn', ...extra }
}

function Harness({ draftKey = 'a', visionEnabled = true, imageLimits }: { draftKey?: string; visionEnabled?: boolean; imageLimits?: ModelImageLimits }) {
  const draft = useComposerDrafts(draftKey)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const controller = useComposerAttachments({ ...draft, draftKey, projectId: 'project', inputRef, t, visionEnabled, imageLimits })
  return <form aria-label="composer" onDrop={event => { void controller.handleComposerDrop(event) }}>
    <textarea aria-label="input" ref={inputRef} value={draft.input} onChange={event => draft.setInput(event.target.value)} />
    <button type="button" onClick={() => void controller.attachTextFiles()}>add</button>
    {draft.attachments.map(attachment => <button type="button" key={attachment.path}
      onClick={() => void controller.convertAttachmentToPath(attachment.path)}>convert {attachment.path}</button>)}
  </form>
}

beforeEach(() => {
  vi.resetAllMocks()
  files.releaseTemporaryAttachments.mockResolvedValue(undefined)
  Object.defineProperty(window, 'gale', { configurable: true, value: { files } })
})
afterEach(() => {
  if (originalApi) Object.defineProperty(window, 'gale', originalApi)
  else Reflect.deleteProperty(window, 'gale')
})

describe('composer attachment paths', () => {
  it.each(['pick', 'drop'])('rejects a noncompliant image at %s and preserves text and valid attachments', async method => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII='
    const selected = [file('/pixel.png', 'image', { dataUri, temporary: true }), file('/notes.txt')]
    files.openText.mockResolvedValue(selected)
    files.fromDroppedFiles.mockResolvedValue(selected)
    render(<Harness imageLimits={{ minShortSide: 2 }} />)
    fireEvent.change(screen.getByLabelText('input'), { target: { value: 'Keep my text' } })
    if (method === 'pick') fireEvent.click(screen.getByText('add'))
    else fireEvent.drop(screen.getByRole('form'), { dataTransfer: { types: ['Files'], files: [new File(['x'], 'pixel.png')] } })
    expect(await screen.findByText('convert /notes.txt')).toBeInTheDocument()
    expect(screen.queryByText('convert /pixel.png')).not.toBeInTheDocument()
    expect(screen.getByLabelText('input')).toHaveValue('Keep my text')
    expect(notices.warning).toHaveBeenCalledWith(expect.stringContaining('/pixel.png: Dimensions 1×1'))
    expect(files.releaseTemporaryAttachments).toHaveBeenCalledWith(['/pixel.png'])
  })

  it('uses the latest model limits when a pending file selection returns', async () => {
    let resolve!: (files: SelectedAttachment[]) => void
    files.openText.mockReturnValue(new Promise<SelectedAttachment[]>(done => { resolve = done }))
    const view = render(<Harness />)
    fireEvent.click(screen.getByText('add'))
    view.rerender(<Harness imageLimits={{ maxBytes: 0 }} />)
    await act(async () => { resolve([file('/pixel.png', 'image', { dataUri: 'data:image/png;base64,AAAA' })]) })
    expect(screen.queryByText('convert /pixel.png')).not.toBeInTheDocument()
    expect(notices.warning).toHaveBeenCalledWith(expect.stringContaining('exceeds the limit of 0'))
  })

  it.each([
    '/Users/tester/Desktop/未命名文件夹/报告 # 100%.txt',
    'C:\\Users\\tester\\Desktop\\未命名文件夹\\报告 # 100%.txt',
    '\\\\server\\共享目录\\报告 # 100%.txt'
  ])('converts an attachment to its unchanged native path: %s', async path => {
    files.openText.mockResolvedValue([file(path)])
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('input'), { target: { value: '帮我分析这个文件' } })
    fireEvent.click(screen.getByText('add'))
    fireEvent.click(await screen.findByText(`convert ${path}`))
    expect(screen.getByLabelText('input')).toHaveValue(`帮我分析这个文件\n${path}`)
    expect(screen.queryByText(`convert ${path}`)).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('input')).toHaveFocus())
    const input = screen.getByLabelText('input') as HTMLTextAreaElement
    expect(input.selectionStart).toBe(input.value.length)
    expect(input.selectionEnd).toBe(input.value.length)
    expect(files.retainTemporaryAttachment).not.toHaveBeenCalled()
    expect(files.releaseTemporaryAttachments).not.toHaveBeenCalled()
  })

  it.each(['pick', 'drop'])('appends unsupported files and folders with %s while retaining supported and failed attachments', async method => {
    const selected = [file('/file.txt'), file('/archive.zip', 'binary'), file('/未命名文件夹', 'binary'),
      file('/missing.txt', 'binary', { skippedReason: 'File not found' })]
    files.openText.mockResolvedValue(selected)
    files.fromDroppedFiles.mockResolvedValue(selected)
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('input'), { target: { value: '已有内容\n' } })
    if (method === 'pick') fireEvent.click(screen.getByText('add'))
    else fireEvent.drop(screen.getByRole('form'), { dataTransfer: { types: ['Files'], files: [new File([''], 'archive.zip')] } })
    await waitFor(() => expect(screen.getByLabelText('input')).toHaveValue('已有内容\n/archive.zip\n/未命名文件夹'))
    expect(screen.getByText('convert /file.txt')).toBeInTheDocument()
    expect(screen.getByText('convert /missing.txt')).toBeInTheDocument()
    expect(screen.queryByText('convert /archive.zip')).not.toBeInTheDocument()
  })

  it('keeps model vision rejection separate from unsupported file formats', async () => {
    files.openText.mockResolvedValue([file('/photo.png', 'image')])
    render(<Harness visionEnabled={false} />)
    fireEvent.click(screen.getByText('add'))
    await waitFor(() => expect(notices.warning).toHaveBeenCalledWith('chat.vision_unsupported_attach'))
    expect(screen.getByLabelText('input')).toHaveValue('')
    expect(screen.queryByText('convert /photo.png')).not.toBeInTheDocument()
  })

  it('appends to the latest input in the originating draft when an import finishes after switching conversations', async () => {
    let complete!: (value: SelectedAttachment[]) => void
    files.openText.mockReturnValue(new Promise<SelectedAttachment[]>(resolve => { complete = resolve }))
    const view = render(<Harness draftKey="a" />)
    fireEvent.change(screen.getByLabelText('input'), { target: { value: '原内容' } })
    fireEvent.click(screen.getByText('add'))
    fireEvent.change(screen.getByLabelText('input'), { target: { value: '继续输入' } })
    view.rerender(<Harness draftKey="b" />)
    fireEvent.change(screen.getByLabelText('input'), { target: { value: '另一个会话' } })
    await act(async () => complete([file('/folder', 'binary')]))
    expect(screen.getByLabelText('input')).toHaveValue('另一个会话')
    view.rerender(<Harness draftKey="a" />)
    expect(screen.getByLabelText('input')).toHaveValue('继续输入\n/folder')
  })

  it('retains temporary content before converting and leaves the attachment intact if retention fails', async () => {
    const attachment = file('/tmp/edit.txt', 'text', { temporary: true })
    files.openText.mockResolvedValue([attachment])
    files.retainTemporaryAttachment.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce('/conversation/attachments/_paths/id/edit.txt')
    render(<Harness />)
    fireEvent.click(screen.getByText('add'))
    fireEvent.click(await screen.findByText('convert /tmp/edit.txt'))
    await waitFor(() => expect(notices.error).toHaveBeenCalled())
    expect(screen.getByText('convert /tmp/edit.txt')).toBeInTheDocument()
    expect(screen.getByLabelText('input')).toHaveValue('')
    expect(files.releaseTemporaryAttachments).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('convert /tmp/edit.txt'))
    await waitFor(() => expect(screen.getByLabelText('input')).toHaveValue('/conversation/attachments/_paths/id/edit.txt'))
    expect(files.releaseTemporaryAttachments).toHaveBeenCalledExactlyOnceWith(['/tmp/edit.txt'])
    expect(files.retainTemporaryAttachment).toHaveBeenCalledWith('/tmp/edit.txt', 'project')
  })
})

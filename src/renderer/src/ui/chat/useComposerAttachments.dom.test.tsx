import { useRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { useTranslation } from 'react-i18next'
import en from '../../../../../data/lang/en.json'
import zhCN from '../../../../../data/lang/zh-CN.json'
import type { SelectedAttachment } from '@shared/types'
import type { ModelImageLimits } from '@shared/modelImageLimits'
import { useComposerDrafts } from './composerDrafts'
import { useComposerAttachments } from './useComposerAttachments'

const notices = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn() }))
vi.mock('../notice', () => ({ notice: notices }))
const translations = createInstance()
const files = { openText: vi.fn(), fromDroppedFiles: vi.fn(), releaseTemporaryAttachments: vi.fn(), retainTemporaryAttachment: vi.fn() }
const originalApi = Object.getOwnPropertyDescriptor(window, 'gale')

function file(path: string, kind: SelectedAttachment['kind'] = 'text', extra: Partial<SelectedAttachment> = {}): SelectedAttachment {
  return { path, name: path, kind, mimeType: kind === 'image' ? 'image/png' : 'text/plain', size: 1, contextPolicy: 'one_turn', ...extra }
}

function Harness({ draftKey = 'a', visionEnabled = true, imageLimits }: { draftKey?: string; visionEnabled?: boolean; imageLimits?: ModelImageLimits }) {
  const { t } = useTranslation(undefined, { i18n: translations })
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

beforeEach(async () => {
  vi.resetAllMocks()
  await translations.init({ lng: 'en', fallbackLng: 'en', interpolation: { escapeValue: false },
    resources: { en: { translation: en }, 'zh-CN': { translation: zhCN } } })
  files.releaseTemporaryAttachments.mockResolvedValue(undefined)
  Object.defineProperty(window, 'gale', { configurable: true, value: { files } })
})
afterEach(() => {
  if (originalApi) Object.defineProperty(window, 'gale', originalApi)
  else Reflect.deleteProperty(window, 'gale')
})

describe('composer attachment paths', () => {
  it.each(['en', 'zh-CN'].flatMap(language => ['pick', 'drop'].map(method => ({ language, method }))))(
    'localizes image rejection at $method in $language and preserves text and valid attachments', async ({ language, method }) => {
    await translations.changeLanguage(language)
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
    expect(notices.warning).toHaveBeenCalledWith(language === 'zh-CN'
      ? '/pixel.png: 图片尺寸为 1×1 像素：短边 1 像素，小于 2 像素的下限。'
      : '/pixel.png: Dimensions 1×1 px: short side 1 px is below the minimum of 2 px.')
    expect(files.releaseTemporaryAttachments).toHaveBeenCalledWith(['/pixel.png'])
  })

  it('uses the active language after changing it without remounting the composer', async () => {
    files.openText.mockResolvedValue([file('/pixel.png', 'image', { dataUri: 'data:image/png;base64,AAAA' })])
    render(<Harness imageLimits={{ maxBytes: 0 }} />)
    fireEvent.change(screen.getByLabelText('input'), { target: { value: 'Keep my draft' } })
    fireEvent.click(screen.getByText('add'))
    await waitFor(() => expect(notices.warning).toHaveBeenLastCalledWith('/pixel.png: Original size 3 bytes exceeds the limit of 0 bytes.'))
    await act(async () => { await translations.changeLanguage('zh-CN') })
    fireEvent.click(screen.getByText('add'))
    await waitFor(() => expect(notices.warning).toHaveBeenLastCalledWith('/pixel.png: 原始图片大小为 3 字节，超过 0 字节的上限。'))
    expect(screen.getByLabelText('input')).toHaveValue('Keep my draft')
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

  it.each(['pick', 'drop'])('uses the new language when a pending %s completes after switching language', async method => {
    let complete!: (value: SelectedAttachment[]) => void
    const pending = new Promise<SelectedAttachment[]>(resolve => { complete = resolve })
    files.openText.mockReturnValue(pending)
    files.fromDroppedFiles.mockReturnValue(pending)
    render(<Harness imageLimits={{ maxBytes: 0 }} />)
    fireEvent.change(screen.getByLabelText('input'), { target: { value: 'Keep my draft' } })
    if (method === 'pick') fireEvent.click(screen.getByText('add'))
    else fireEvent.drop(screen.getByRole('form'), { dataTransfer: { types: ['Files'], files: [new File(['x'], 'pixel.png')] } })
    await act(async () => { await translations.changeLanguage('zh-CN') })
    await act(async () => complete([file('/pixel.png', 'image', { dataUri: 'data:image/png;base64,AAAA', temporary: true })]))
    expect(notices.warning).toHaveBeenLastCalledWith('/pixel.png: 原始图片大小为 3 字节，超过 0 字节的上限。')
    expect(screen.getByLabelText('input')).toHaveValue('Keep my draft')
    expect(screen.queryByText('convert /pixel.png')).not.toBeInTheDocument()
    expect(files.releaseTemporaryAttachments).toHaveBeenCalledWith(['/pixel.png'])
  })

  it('uses the new language when pending attachment reading fails', async () => {
    let reject!: (reason: Error) => void
    files.openText.mockReturnValue(new Promise<SelectedAttachment[]>((_resolve, fail) => { reject = fail }))
    render(<Harness />)
    fireEvent.click(screen.getByText('add'))
    await act(async () => { await translations.changeLanguage('zh-CN') })
    await act(async () => reject(new Error('Read failed')))
    expect(notices.error).toHaveBeenLastCalledWith(zhCN.chat.failed_attach_file)
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

  it.each([
    '/Users/tester/Desktop/未命名文件夹/图片 # 100%.png',
    'C:\\Users\\tester\\Desktop\\未命名文件夹\\图片 # 100%.png',
    '\\\\server\\共享目录\\图片 # 100%.png'
  ])('uses the original source path when converting an edited image: %s', async sourcePath => {
    const temporaryPath = '/tmp/message_edit/draft/0000/image.png'
    files.retainTemporaryAttachment.mockResolvedValue('/archive/_paths/copy/image.png')
    files.openText.mockResolvedValue([
      file(temporaryPath, 'image', { temporary: true, sourcePath }),
      file('/other.txt')
    ])
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('input'), { target: { value: '保留已有内容' } })
    fireEvent.click(screen.getByText('add'))
    fireEvent.click(await screen.findByText(`convert ${temporaryPath}`))
    await waitFor(() => expect(screen.getByLabelText('input')).toHaveValue(`保留已有内容\n${sourcePath}`))
    expect(screen.queryByText(`convert ${temporaryPath}`)).not.toBeInTheDocument()
    expect(screen.getByText('convert /other.txt')).toBeInTheDocument()
    expect(files.retainTemporaryAttachment).not.toHaveBeenCalled()
    expect(files.releaseTemporaryAttachments).toHaveBeenCalledExactlyOnceWith([temporaryPath])
  })

  it('uses the original source path for an archived attachment without removing its archive', async () => {
    const path = '/archive/image.png', sourcePath = '/original/image.png'
    files.openText.mockResolvedValue([file(path, 'image', { sourcePath })])
    render(<Harness />)
    fireEvent.click(screen.getByText('add'))
    fireEvent.click(await screen.findByText(`convert ${path}`))
    expect(screen.getByLabelText('input')).toHaveValue(sourcePath)
    expect(files.retainTemporaryAttachment).not.toHaveBeenCalled()
    expect(files.releaseTemporaryAttachments).not.toHaveBeenCalled()
  })

  it('keeps model vision rejection separate from unsupported file formats', async () => {
    files.openText.mockResolvedValue([file('/photo.png', 'image')])
    render(<Harness visionEnabled={false} />)
    fireEvent.click(screen.getByText('add'))
    await waitFor(() => expect(notices.warning).toHaveBeenCalledWith(en.chat.vision_unsupported_attach))
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

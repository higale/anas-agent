import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const previewMocks = vi.hoisted(() => ({
  loadAttachmentPreview: vi.fn(),
  showItemInFolder: vi.fn()
}))

vi.mock('./attachmentPreviewLoader', () => previewMocks)

import { MarkdownText, MarkdownWorkspaceProjectProvider } from './MarkdownText'

beforeEach(() => {
  Object.defineProperty(window, 'gale', {
    configurable: true,
    value: { files: { showItemInFolder: previewMocks.showItemInFolder.mockReset().mockResolvedValue('') } }
  })
  previewMocks.loadAttachmentPreview.mockReset().mockResolvedValue({
    path: '/workspace/images/avatar.png',
    mimeType: 'image/png',
    src: 'data:image/png;base64,AQ=='
  })
})

describe('Markdown workspace images', () => {
  it('resolves document-relative images against the Markdown file, including encoded filename characters', async () => {
    render(<MarkdownText text="![Local](./images/photo%20%231.png)" documentPath="/skills/demo/SKILL.md" />)
    await waitFor(() => expect(previewMocks.loadAttachmentPreview).toHaveBeenCalledWith(
      '/skills/demo/images/photo #1.png', { mode: 'thumbnail', projectId: undefined }
    ))
  })

  it('resolves document-relative links through the existing local file action', async () => {
    const view = render(<MarkdownText text="[Guide](../guide.md)" documentPath="/skills/demo/SKILL.md" />)
    fireEvent.click(view.getByRole('link', { name: 'Guide' }))
    await waitFor(() => expect(previewMocks.showItemInFolder).toHaveBeenCalledWith('/skills/guide.md'))
  })
  it.each([
    ['C:\\Users\\user\\Pictures\\002.png', 'C:\\Users\\user\\Pictures\\002.png'],
    ['<C:\\Pictures\\鱼缸 %23 100%25.png>', 'C:\\Pictures\\鱼缸 # 100%.png'],
    ['<C:/Pictures/鱼缸 %23 100%25.png>', 'C:/Pictures/鱼缸 # 100%.png'],
    ['</Pictures/鱼缸 %23 100%25.png>', '/Pictures/鱼缸 # 100%.png'],
    ['file:///C:/Pictures/%E9%B1%BC%E7%BC%B8%20%23%20100%25.png', 'C:\\Pictures\\鱼缸 # 100%.png']
  ])('loads a local Markdown image from %s', async (destination, expectedPath) => {
    const view = render(<MarkdownText text={`![Fish tank](${destination})`} />)

    await waitFor(() => expect(previewMocks.loadAttachmentPreview).toHaveBeenCalledWith(
      expectedPath, { mode: 'thumbnail', projectId: undefined }
    ))
    expect(await view.findByRole('img', { name: 'Fish tank' })).toHaveAttribute('src', 'data:image/png;base64,AQ==')
  })

  it.each(['', 'javascript:invalid'])('shows a failure instead of loading forever for an invalid image source: %s', async (source) => {
    const view = render(<MarkdownText text={`![Invalid image](${source})`} />)

    expect(await view.findByText('Invalid image: chat.image_preview_failed')).toBeVisible()
    expect(previewMocks.loadAttachmentPreview).not.toHaveBeenCalled()
    expect(view.queryByText('common.loading')).not.toBeInTheDocument()
  })

  it.each([false, true])('reveals the resolved image file while original loading is pending: %s', async (pending) => {
    const resolvedPath = 'D:\\workspace\\images\\avatar.png'
    previewMocks.loadAttachmentPreview.mockImplementation(async (_path, options) => {
      if (pending && options.mode === 'original') return new Promise(() => {})
      return {
        path: resolvedPath,
        mimeType: 'image/png',
        src: options.mode === 'original' ? 'anas-image://local/avatar' : 'data:image/png;base64,AQ=='
      }
    })
    const view = render(
      <MarkdownWorkspaceProjectProvider projectId="project-a">
        <MarkdownText text="![Avatar](images/avatar.png)" />
      </MarkdownWorkspaceProjectProvider>
    )

    fireEvent.click(await view.findByRole('button', { name: 'Avatar' }))
    if (!pending) {
      await waitFor(() => expect(view.getByRole('dialog').querySelector('img'))
        .toHaveAttribute('src', 'anas-image://local/avatar'))
    }
    fireEvent.click(await view.findByRole('button', { name: 'chat.show_attachment_in_folder' }))

    await waitFor(() => expect(previewMocks.showItemInFolder).toHaveBeenCalledWith(resolvedPath))
  })

  it('loads a relative image through the current project context', async () => {
    const view = render(
      <MarkdownWorkspaceProjectProvider projectId="project-a">
        <MarkdownText text="![Avatar](images/avatar.png)" />
      </MarkdownWorkspaceProjectProvider>
    )

    await waitFor(() => expect(previewMocks.loadAttachmentPreview).toHaveBeenCalledWith(
      'images/avatar.png',
      { mode: 'thumbnail', projectId: 'project-a' }
    ))
    await waitFor(() => expect(view.getByRole('img', { name: 'Avatar' }))
      .toHaveAttribute('src', 'data:image/png;base64,AQ=='))
  })
})

describe('Markdown document navigation', () => {
  it('keeps slash commands as code in documents while chat still links local paths', () => {
    const text = '`/name@user arguments`\n\n`/workspace/file.md`\n\n[Guide](./USER_GUIDE.en.md)'
    const view = render(<MarkdownText text={text} onNavigate={vi.fn()} />)
    expect(view.getAllByRole('link')).toHaveLength(1)
    expect(view.getByText('/name@user arguments').tagName).toBe('CODE')
    expect(view.getByText('/workspace/file.md').tagName).toBe('CODE')

    view.rerender(<MarkdownText text={text} />)
    expect(view.getByRole('link', { name: '/workspace/file.md' })).toHaveAttribute('href', expect.stringContaining('anas-local-file:'))
  })
})

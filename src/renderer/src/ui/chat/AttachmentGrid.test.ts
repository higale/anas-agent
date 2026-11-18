import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { SelectedAttachment } from '@shared/types'
import { AttachmentGrid } from './AttachmentGrid'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const attachment: SelectedAttachment = {
  path: '/workspace/notes.txt',
  name: 'notes.txt',
  size: 12,
  kind: 'text',
  mimeType: 'text/plain',
  contextPolicy: 'one_turn'
}

describe('AttachmentGrid accessibility', () => {
  it.each(['C:\\资料\\notes.txt', '/Users/example/资料/notes.txt', 'notes.txt'])(
    'shows a compact filename and retains the source label in its tooltip (%s)', name => {
      const html = renderToStaticMarkup(createElement(AttachmentGrid, { attachments: [{ ...attachment, sourcePath: name === 'notes.txt' ? undefined : name }], mode: 'message' }))
      expect(html).toContain('data-tooltip="' + name + '"')
      expect(html).toContain('>notes.txt</strong>')
      expect(html).toContain('aria-label="chat.show_attachment_in_folder: notes.txt"')
    })

  it('keeps open, remove, and context actions as sibling native buttons', () => {
    const html = renderToStaticMarkup(createElement(AttachmentGrid, {
      attachments: [attachment],
      mode: 'composer',
      onRemoveAttachment: vi.fn(),
      onToggleContextPolicy: vi.fn()
    }))

    expect(html).not.toContain('role="button"')
    expect(html.match(/<button/g)).toHaveLength(3)
    expect(html).toMatch(/<button[^>]*attachment-open[^>]*>.*<\/button><button[^>]*attachment-remove/s)
    expect(html).toContain('aria-pressed="false"')
  })
})

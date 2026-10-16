import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notice } from '../notice'
import { ProviderIconField } from './ProviderIconField'
import { modelTemplates } from '@shared/modelTemplates'
import { maxProviderSvgBytes } from '@shared/providerIcon'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))
const decode = vi.fn<() => Promise<void>>()
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
const pngData = `data:image/png;base64,${pngBytes.toString('base64')}`
let dimensions = { width: 24, height: 24 }

function webp(...chunks: Array<[string, Buffer]>): Buffer<ArrayBuffer> {
  const body = Buffer.concat(chunks.map(([type, payload]) => {
    const header = Buffer.alloc(8)
    header.write(type)
    header.writeUInt32LE(payload.length, 4)
    return Buffer.concat([header, payload, Buffer.alloc(payload.length % 2)])
  }))
  const header = Buffer.alloc(12)
  header.write('RIFF')
  header.writeUInt32LE(body.length + 4, 4)
  header.write('WEBP', 8)
  return Buffer.concat([header, body])
}

beforeEach(() => {
  decode.mockResolvedValue(undefined)
  dimensions = { width: 24, height: 24 }
  vi.stubGlobal('Image', class {
    naturalWidth = dimensions.width
    naturalHeight = dimensions.height
    src = ''
    decode = decode
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('provider icon uploads', () => {
  it('keeps an empty icon generic until Reset is clicked, then saves the URL-matched icon', () => {
    const first = modelTemplates.find((template) => template.name === 'DeepSeek')!
    const second = modelTemplates.find((template) => template.name === 'MiniMax')!
    const onChange = vi.fn()
    const view = render(<ProviderIconField iconData="" baseUrl={first.baseUrl} onChange={onChange} />)
    expect(view.container.querySelector('img')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'settings.provider_icon_remove' }))
    expect(onChange).toHaveBeenLastCalledWith(first.iconData)

    view.rerender(<ProviderIconField iconData={first.iconData!} baseUrl={second.baseUrl} onChange={onChange} />)
    expect(view.container.querySelector('img')).toHaveAttribute('src', first.iconData)
    expect(onChange).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'settings.provider_icon_remove' }))
    expect(onChange).toHaveBeenLastCalledWith(second.iconData)

    view.rerender(<ProviderIconField iconData={second.iconData!} baseUrl="https://unknown.example/v1" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.provider_icon_remove' }))
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it.each(['svg', 'png'])('preserves uploaded %s bytes and supports removal', async (extension) => {
    const onChange = vi.fn()
    const mime = extension === 'svg' ? 'image/svg+xml' : 'image/png'
    const contents = extension === 'svg' ? '<svg xmlns="http://www.w3.org/2000/svg">图标</svg>' : pngBytes
    const data = `data:${mime};base64,${Buffer.from(contents).toString('base64')}`
    const view = render(<ProviderIconField iconData="" onChange={onChange} />)
    fireEvent.change(view.container.querySelector('input')!, { target: { files: [new File([contents], `icon.${extension}`, { type: mime })] } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(data))
    view.rerender(<ProviderIconField iconData={data} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.provider_icon_remove' }))
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('reports a corrupt image without replacing the existing icon', async () => {
    decode.mockRejectedValueOnce(new Error('Broken SVG'))
    const onChange = vi.fn()
    const view = render(<ProviderIconField iconData="" onChange={onChange} />)
    fireEvent.change(view.container.querySelector('input')!, { target: { files: [new File(['broken'], 'icon.svg')] } })
    await waitFor(() => expect(notice.error).toHaveBeenCalledWith('settings.provider_icon_invalid'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'icon.svg', contents: new Uint8Array(maxProviderSvgBytes + 1), error: 'svg_too_large' },
    { name: 'icon.avif', contents: 'avif', error: 'unsupported_type' },
    { name: 'icon.jpg', contents: pngBytes, error: 'invalid' },
    { name: 'icon.bmp', contents: pngBytes, error: 'invalid' },
    { name: 'icon.webp', contents: 'RIFF broken', error: 'invalid' },
    { name: 'icon.gif', contents: 'GIF89a', error: 'animation_unsupported' },
    { name: 'renamed.png', contents: 'GIF89a', error: 'animation_unsupported' },
    { name: 'animated.webp', contents: webp(['VP8X', Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0])]), error: 'animation_unsupported' },
    { name: 'animated.webp', contents: webp(['ANIM', Buffer.alloc(6)]), error: 'animation_unsupported' },
    { name: 'animated.webp', contents: webp(['ANMF', Buffer.alloc(16)]), error: 'animation_unsupported' },
    { name: 'truncated.webp', contents: webp(['VP8 ', Buffer.alloc(8)]).subarray(0, 24), error: 'invalid' },
    { name: 'icon.png', contents: 'not a PNG', error: 'invalid' }
  ])('reports $error without replacing the icon', async ({ name, contents, error }) => {
    const onChange = vi.fn()
    const view = render(<ProviderIconField iconData={pngData} onChange={onChange} />)
    fireEvent.change(view.container.querySelector('input')!, { target: { files: [new File([contents], name)] } })
    await waitFor(() => expect(notice.error).toHaveBeenCalledWith(`settings.provider_icon_${error}`))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('preserves SVG bytes at the 1 MB boundary regardless of dimensions', async () => {
    dimensions = { width: 4096, height: 2048 }
    const contents = ' '.repeat(maxProviderSvgBytes)
    const onChange = vi.fn()
    const view = render(<ProviderIconField iconData="" onChange={onChange} />)
    fireEvent.change(view.container.querySelector('input')!, { target: { files: [new File([contents], 'icon.svg')] } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(`data:image/svg+xml;base64,${Buffer.from(contents).toString('base64')}`))
  })

  it('preserves a 512 pixel square PNG without re-encoding', async () => {
    dimensions = { width: 512, height: 512 }
    const onChange = vi.fn()
    const view = render(<ProviderIconField iconData="" onChange={onChange} />)
    fireEvent.change(view.container.querySelector('input')!, { target: { files: [new File([pngBytes], 'icon.png')] } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(pngData))
  })

  it.each([
    { extension: 'jpg', contents: Buffer.from([255, 216, 255, 224]) },
    { extension: 'JPEG', contents: Buffer.from([255, 216, 255, 224]) },
    { extension: 'bmp', contents: Buffer.from('BM bitmap') },
    { extension: 'webp', contents: webp(['VP8 ', Buffer.alloc(8)]) },
    { extension: 'webp', contents: webp(['VP8L', Buffer.alloc(8)]) },
    // Metadata text must not be mistaken for an animation chunk; odd chunks have padding.
    { extension: 'webp', contents: webp(['VP8X', Buffer.alloc(10)], ['XMP ', Buffer.from('ANIM!')], ['VP8 ', Buffer.alloc(8)]) }
  ])('converts a small square $extension to PNG without enlarging it', async ({ extension, contents }) => {
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement, type) {
      expect(type).toBe('image/png')
      expect(this.width).toBe(24)
      expect(this.height).toBe(24)
      return pngData
    })
    const onChange = vi.fn()
    const view = render(<ProviderIconField iconData="" onChange={onChange} />)
    fireEvent.change(view.container.querySelector('input')!, { target: { files: [new File([contents], `icon.${extension}`)] } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(pngData))
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 24, 24, 0, 0, 24, 24)
  })

  it.each([
    { width: 1200, height: 800, x: 200, y: 0, side: 800, output: 512 },
    { width: 200, height: 400, x: 0, y: 100, side: 200, output: 200 },
    { width: 513, height: 513, x: 0, y: 0, side: 513, output: 512 }
  ])('center-crops and shrinks a $width × $height PNG without enlarging it', async ({ width, height, x, y, side, output }) => {
    dimensions = { width, height }
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement, type) {
      expect(type).toBe('image/png')
      expect(this.width).toBe(output)
      expect(this.height).toBe(output)
      return pngData
    })
    const onChange = vi.fn()
    const view = render(<ProviderIconField iconData="" onChange={onChange} />)
    // PNG is limited by output dimensions, not by the SVG file-size limit.
    fireEvent.drop(view.container.querySelector('.ui-avatar')!, {
      dataTransfer: { files: [new File([pngBytes, new Uint8Array(maxProviderSvgBytes)], 'icon.png')] }
    })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(pngData))
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), x, y, side, side, 0, 0, output, output)
  })

  it('reports PNG processing failure without replacing the icon', async () => {
    dimensions = { width: 1024, height: 1024 }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const onChange = vi.fn()
    const view = render(<ProviderIconField iconData={pngData} onChange={onChange} />)
    fireEvent.change(view.container.querySelector('input')!, { target: { files: [new File([pngBytes], 'icon.png')] } })
    await waitFor(() => expect(notice.error).toHaveBeenCalledWith('settings.provider_icon_processing_failed'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not apply an upload after switching to another provider', async () => {
    let finish!: () => void
    decode.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const onChange = vi.fn()
    const view = render(<ProviderIconField key="first" iconData="" onChange={onChange} />)
    fireEvent.change(view.container.querySelector('input')!, { target: { files: [new File(['svg'], 'icon.svg')] } })
    await waitFor(() => expect(decode).toHaveBeenCalled())
    view.rerender(<ProviderIconField key="second" iconData="" onChange={onChange} />)
    await act(async () => finish())
    expect(onChange).not.toHaveBeenCalled()
  })
})

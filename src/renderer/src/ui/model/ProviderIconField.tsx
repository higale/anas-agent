import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { maxProviderPngSide, maxProviderSvgBytes, normalizeProviderIconData } from '@shared/providerIcon'
import { findModelTemplateIcon } from '@shared/modelTemplates'
import { UI_ICON_SIZE_TINY } from '../uiConstants'
import { notice } from '../notice'
import { ProviderIcon } from './ProviderIcon'

interface ProviderIconFieldProps {
  iconData: string
  baseUrl?: string
  onChange: (iconData: string) => void
}

type IconUploadErrorCode = 'unsupported_type' | 'animation_unsupported' | 'svg_too_large' | 'read_failed' | 'invalid' | 'processing_failed'

const iconMimeTypes: Record<string, string> = {
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', bmp: 'image/bmp'
}

class IconUploadError extends Error {
  constructor(readonly code: IconUploadErrorCode) {
    super(code)
  }
}

function validateStaticWebp(bytes: string): void {
  const uint32 = (offset: number) => (
    bytes.charCodeAt(offset) + bytes.charCodeAt(offset + 1) * 256
    + bytes.charCodeAt(offset + 2) * 65536 + bytes.charCodeAt(offset + 3) * 16777216
  )
  if (bytes.length < 12 || bytes.slice(0, 4) !== 'RIFF' || bytes.slice(8, 12) !== 'WEBP') {
    throw new IconUploadError('invalid')
  }
  const end = uint32(4) + 8
  if (end > bytes.length || end < 20) throw new IconUploadError('invalid')
  // RIFF chunks include even-byte padding; inspect chunk headers, not arbitrary image/metadata bytes.
  for (let offset = 12; offset < end;) {
    if (offset + 8 > end) throw new IconUploadError('invalid')
    const type = bytes.slice(offset, offset + 4)
    const size = uint32(offset + 4)
    const next = offset + 8 + size + size % 2
    if (next > end) throw new IconUploadError('invalid')
    if (type === 'ANIM' || type === 'ANMF'
      || (type === 'VP8X' && size > 0 && (bytes.charCodeAt(offset + 8) & 0x02) !== 0)) {
      throw new IconUploadError('animation_unsupported')
    }
    offset = next
  }
}

async function readIcon(file: File): Promise<string> {
  const extension = file.name.match(/\.([^.]+)$/)?.[1].toLowerCase() ?? ''
  if (extension === 'gif') throw new IconUploadError('animation_unsupported')
  const mime = Object.hasOwn(iconMimeTypes, extension) ? iconMimeTypes[extension] : undefined
  if (!mime) throw new IconUploadError('unsupported_type')
  if (mime === 'image/svg+xml' && file.size > maxProviderSvgBytes) throw new IconUploadError('svg_too_large')
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new IconUploadError('read_failed'))
    reader.onload = () => resolve(`data:${mime};base64,${String(reader.result).split(',')[1]}`)
    reader.readAsDataURL(file)
  })
  if (mime !== 'image/svg+xml') {
    const bytes = atob(data.split(',')[1])
    if (bytes.startsWith('GIF87a') || bytes.startsWith('GIF89a')) throw new IconUploadError('animation_unsupported')
    if ((mime === 'image/png' && !bytes.startsWith('\x89PNG\r\n\x1a\n'))
      || (mime === 'image/jpeg' && !bytes.startsWith('\xff\xd8\xff'))
      || (mime === 'image/bmp' && !bytes.startsWith('BM'))) throw new IconUploadError('invalid')
    if (mime === 'image/webp') validateStaticWebp(bytes)
  }
  // Decode as an image, never insert uploaded SVG markup into the document.
  const image = new Image()
  image.src = data
  await image.decode()
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (!width || !height) throw new IconUploadError('invalid')
  if (mime === 'image/svg+xml' || (mime === 'image/png' && width === height && width <= maxProviderPngSide)) {
    return normalizeProviderIconData(data)
  }
  try {
    const side = Math.min(width, height)
    const outputSide = Math.min(side, maxProviderPngSide)
    const canvas = document.createElement('canvas')
    canvas.width = outputSide
    canvas.height = outputSide
    const context = canvas.getContext('2d')
    if (!context) throw new IconUploadError('processing_failed')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, outputSide, outputSide)
    return normalizeProviderIconData(canvas.toDataURL('image/png'))
  } catch {
    throw new IconUploadError('processing_failed')
  }
}

export function ProviderIconField({ iconData, baseUrl, onChange }: ProviderIconFieldProps) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  const operation = useRef(0)
  const [dragActive, setDragActive] = useState(false)
  useEffect(() => () => { operation.current += 1 }, [])

  async function upload(file: File | undefined): Promise<void> {
    if (!file) return
    const current = ++operation.current
    try {
      const data = await readIcon(file)
      if (current === operation.current) onChange(data)
    } catch (error) {
      if (current === operation.current) {
        notice.error(t(`settings.provider_icon_${error instanceof IconUploadError ? error.code : 'invalid'}`))
      }
    }
  }

  return (
    <div className="provider-icon-field">
      <input
        ref={input}
        type="file"
        accept=".svg,.png,.jpg,.jpeg,.webp,.bmp,image/svg+xml,image/png,image/jpeg,image/webp,image/bmp"
        hidden
        aria-label={t('settings.provider_icon_edit')}
        onChange={(event) => {
          void upload(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      <div className="ui-corner-host ui-hover-reveal">
        <button
          className={`ui-avatar ui-avatar-lg ui-avatar-contain${dragActive ? ' ui-avatar-active' : ''}`}
          type="button"
          aria-label={t('settings.provider_icon_edit')}
          data-tooltip={t('settings.provider_icon_edit')}
          onClick={() => input.current?.click()}
          onDragOver={(event) => { event.preventDefault(); setDragActive(true) }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragActive(false)
            void upload(event.dataTransfer.files[0])
          }}
        >
          <ProviderIcon iconData={iconData} size={32} />
        </button>
        {(iconData || baseUrl) && (
          <button
            className="ui-corner-action ui-hover-reveal-target ui-icon-button ui-icon-button-xs ui-button-danger"
            type="button"
            aria-label={t('settings.provider_icon_remove')}
            data-tooltip={t('settings.provider_icon_remove')}
            onClick={() => {
              operation.current += 1
              onChange(findModelTemplateIcon(baseUrl ?? '') ?? '')
            }}
          >
            <Trash2 size={UI_ICON_SIZE_TINY} />
          </button>
        )}
      </div>
    </div>
  )
}

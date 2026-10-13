import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PluginIcon } from './PluginIcon'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe('plugin icon rendering', () => {
  it('uses the same asset as a monochrome mask and reports missing images', () => {
    const failed = vi.fn(), source = 'anas-plugin://example/_anas/icon/assets/custom.svg'
    const { container } = render(<PluginIcon icon={{ light: source, dark: source }} monochrome onError={failed} />)
    const image = container.querySelector('img')!
    expect(image.parentElement!.style.maskImage).toContain(source)
    expect(image).toHaveAttribute('width', '16')
    fireEvent.error(image)
    expect(failed).toHaveBeenCalledOnce()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
  it('keeps an icon-sized, non-draggable image and falls back after decode failure', () => {
    const failed = vi.fn()
    const source = 'anas-plugin://example/_anas/icon/icon.svg'
    const { container, rerender } = render(<PluginIcon icon={{ light: source, dark: source }} size={14} onError={failed} />)
    const image = container.querySelector('img')!
    expect(image).toHaveAttribute('width', '14')
    expect(image).toHaveAttribute('draggable', 'false')
    fireEvent.error(image)
    expect(failed).toHaveBeenCalledOnce()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
    rerender(<PluginIcon icon={{ light: source + '2', dark: source + '2' }} size={14} />)
    expect(container.querySelector('img')).toHaveAttribute('src', source + '2')
  })

  it('keeps light and dark variants independent when one image fails', () => {
    const { container } = render(<PluginIcon icon={{ light: 'light.png', dark: 'dark.webp' }} />)
    fireEvent.error(container.querySelector('img[src="light.png"]')!)
    expect(container.querySelector('img[src="dark.webp"]')).not.toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})

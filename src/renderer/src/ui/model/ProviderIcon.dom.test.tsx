import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProviderIcon } from './ProviderIcon'

describe('ProviderIcon', () => {
  it('uses the stored image and returns to a generic icon when removed', () => {
    const iconData = 'data:image/svg+xml;base64,PHN2Zy8+'
    const { container, rerender } = render(<ProviderIcon iconData={iconData} />)
    expect(container.querySelector('img')).toHaveAttribute('src', iconData)
    expect(container.querySelector('svg')).toBeNull()
    rerender(<ProviderIcon iconData="" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).toBeInTheDocument()
  })
})

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AppearanceSettings } from './AppearanceSettings'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('appearance settings layout', () => {
  it('renders divided appearance rows and saves the titlebar checkbox independently of the theme', async () => {
    const onSaveTheme = vi.fn(), onSaveShowThemeInTitlebar = vi.fn()
    const props = {
      languageOptions: [{ code: 'en', name: 'English', builtIn: true }], languageValue: 'en', systemLanguage: 'system',
      themeValue: 'dark', fontSizeValue: 15, showThemeInTitlebar: true,
      onSaveLanguage: vi.fn(), onSaveTheme, onSaveShowThemeInTitlebar, onSaveFontSize: vi.fn()
    }
    const { rerender } = render(
      <AppearanceSettings
        {...props}
      />
    )

    const card = document.querySelector('.settings-card')
    expect(card).toBeInTheDocument()
    expect(card?.children).toHaveLength(3)
    expect(screen.getByRole('heading', { level: 2, name: 'settings.appearance' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'settings.language' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'settings.theme' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'settings.theme_dark' })).toBeChecked()
    const fontSizeInput = screen.getByRole('slider', { name: 'settings.font_size' })
    expect(fontSizeInput).toHaveAttribute('aria-valuenow', '15')
    expect(fontSizeInput).toHaveAttribute('aria-valuetext', '15 px')
    expect(screen.getByText('15 px')).toBeVisible()
    expect(fontSizeInput).toHaveAttribute('aria-valuemax', '18')
    expect(Array.from(card?.children ?? []).every((row) => row.classList.contains('ui-form-row-narrow'))).toBe(true)
    expect(fontSizeInput.closest('.ui-range-row')).toHaveClass('ui-form-row-narrow')
    expect(screen.queryByRole('radiogroup', { name: 'settings.chat_content_width' })).toBeNull()
    const checkbox = screen.getByRole('checkbox', { name: 'settings.theme_titlebar_icon' })
    expect(checkbox).toBeChecked()
    await userEvent.click(checkbox)
    expect(onSaveShowThemeInTitlebar).toHaveBeenCalledExactlyOnceWith(false)
    expect(onSaveTheme).not.toHaveBeenCalled()
    rerender(<AppearanceSettings {...props} showThemeInTitlebar={false} />)
    expect(checkbox).not.toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: 'settings.theme_system' }))
    expect(onSaveTheme).toHaveBeenCalledExactlyOnceWith('system')
  })
})

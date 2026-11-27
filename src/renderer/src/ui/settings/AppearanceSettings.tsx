import { Globe } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LanguagePackSummary } from '@shared/types'
import { UI_FONT_SIZE_MAX, UI_FONT_SIZE_MIN, normalizeUiFontSize } from '@shared/uiPreferences'
import { RangeField } from '../RangeField'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { SegmentedControl } from '../SegmentedControl'
import { UI_ICON_SIZE_NAV } from '../uiConstants'
import { SettingsGroup } from './SettingsGroup'
import { CheckboxField } from '../CheckboxField'
import { normalizeTheme, themeOptions, type ThemeMode } from '../theme'

const FONT_SIZE_MARKS = Array.from({ length: UI_FONT_SIZE_MAX - UI_FONT_SIZE_MIN + 1 }, (_, index) => {
  const value = UI_FONT_SIZE_MIN + index
  return { value, label: index % 2 === 0 ? String(value) : undefined }
})

interface AppearanceSettingsProps {
  languageOptions: LanguagePackSummary[]
  languageValue: string
  systemLanguage: string
  themeValue?: string
  showThemeInTitlebar: boolean
  fontSizeValue?: number
  onSaveLanguage: (language: string) => void | Promise<void>
  onSaveTheme: (theme: ThemeMode) => void | Promise<void>
  onSaveShowThemeInTitlebar: (visible: boolean) => void | Promise<void>
  onSaveFontSize: (fontSize: number) => void | Promise<void>
}

export function AppearanceSettings({
  languageOptions,
  languageValue,
  systemLanguage,
  themeValue,
  showThemeInTitlebar,
  fontSizeValue,
  onSaveLanguage,
  onSaveTheme,
  onSaveShowThemeInTitlebar,
  onSaveFontSize
}: AppearanceSettingsProps) {
  const { t } = useTranslation()
  const fontSize = normalizeUiFontSize(fontSizeValue)
  const languagePickerOptions = [
    { value: systemLanguage, label: t('settings.language_system') },
    ...languageOptions.map((language) => ({
      value: language.code,
      label: `${language.name} (${language.code})`,
      searchText: `${language.name} ${language.code}`
    }))
  ]
  const themePickerOptions = themeOptions.map(({ value, label, Icon }) => ({ value, label: t(label), icon: <Icon size="1em" /> }))

  return (
    <SettingsGroup title={t('settings.appearance')}>
      <div className="ui-form-row ui-form-row-narrow">
        <span>
          <strong className="ui-row">
            <Globe size={UI_ICON_SIZE_NAV} aria-hidden="true" />
            <span>{t('settings.language')}</span>
          </strong>
          <small>{t('settings.language_hint')}</small>
        </span>
        <SearchableOptionPicker
          ariaLabel={t('settings.language')}
          emptyLabel={t('settings.no_options')}
          options={languagePickerOptions}
          searchable={false}
          value={languageValue}
          onChange={(language) => void onSaveLanguage(language)}
        />
      </div>
      <div className="ui-form-row ui-form-row-narrow ui-form-row-inline">
        <span>
          <strong>{t('settings.theme')}</strong>
          <small>{t('settings.theme_hint')}</small>
        </span>
        <div className="ui-toolbar ui-form-row-controls">
          <CheckboxField label={t('settings.theme_titlebar_icon')}
            checked={showThemeInTitlebar} onChange={visible => void onSaveShowThemeInTitlebar(visible)} />
          <SegmentedControl
            ariaLabel={t('settings.theme')}
            minWidth="var(--settings-control-width-narrow-preferred)"
            options={themePickerOptions}
            value={normalizeTheme(themeValue)}
            onChange={(theme) => void onSaveTheme(normalizeTheme(theme))}
          />
        </div>
      </div>
      <RangeField
        ariaLabel={t('settings.font_size')}
        className="ui-form-row ui-form-row-narrow"
        label={<>
          <strong>{t('settings.font_size')}</strong>
          <small>{t('settings.font_size_hint')}</small>
        </>}
        min={UI_FONT_SIZE_MIN}
        max={UI_FONT_SIZE_MAX}
        marks={FONT_SIZE_MARKS}
        step={1}
        value={fontSize}
        formatValue={(value) => `${value} px`}
        onChange={(value) => void onSaveFontSize(normalizeUiFontSize(value))}
      />
    </SettingsGroup>
  )
}

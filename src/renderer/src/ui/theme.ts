import { Moon, Sun } from 'lucide-react'
import { SystemThemeIcon } from './SystemThemeIcon'

export type ThemeMode = 'system' | 'light' | 'dark'

export const themeOptions = [
  { value: 'system', label: 'settings.theme_system', Icon: SystemThemeIcon },
  { value: 'light', label: 'settings.theme_light', Icon: Sun },
  { value: 'dark', label: 'settings.theme_dark', Icon: Moon }
] as const

export function normalizeTheme(value?: string): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system'
}

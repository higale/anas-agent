import { nativeTheme, type BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'

export function titleBarColors(): { backgroundColor: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors
    ? { backgroundColor: '#202020', symbolColor: '#e5e5e5' }
    : { backgroundColor: '#f5f5f5', symbolColor: '#252525' }
}

export function titleBarOptions(options: { compact?: boolean } = {}): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'> {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: options.compact ? 11 : 18 }
    }
  }

  const colors = titleBarColors()
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: colors.backgroundColor,
      symbolColor: colors.symbolColor,
      height: 36
    }
  }
}

export function applyWindowTheme(win: BrowserWindow): void {
  const colors = titleBarColors()
  win.setBackgroundColor(colors.backgroundColor)
  if (process.platform === 'darwin') return
  try {
    win.setTitleBarOverlay({
      color: colors.backgroundColor,
      symbolColor: colors.symbolColor,
      height: 36
    })
  } catch {
    // Some Linux window managers ignore or reject title bar overlay updates.
  }
}

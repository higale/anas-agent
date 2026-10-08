import { BrowserWindow } from 'electron'
import type { EventEmitter } from 'node:events'
import { requireNativeTooltip, tooltipStyleProperties, type NativeTooltip } from '@shared/nativeTooltip'
import { preserveWindowAppearance } from '../windowAppearance'

const shadowMargin = 32
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

function tooltipHtml(value: NativeTooltip): string {
  const style = tooltipStyleProperties.map(key => `${key}:${value.styles[key]}`).join(';')
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>html,body{margin:0;background:transparent;overflow:hidden}div{position:absolute;box-sizing:border-box;left:${shadowMargin}px;top:${shadowMargin}px;width:${value.bounds.width}px;pointer-events:none}</style>
    <div role="tooltip" style="${escapeHtml(style)}">${escapeHtml(value.label)}</div>`
}

/** A small, non-interactive native surface above sibling WebContentsViews. */
export class NativeTooltips {
  private entries = new Map<BrowserWindow, { window: BrowserWindow; key: string; dispose(): void }>()

  async set(owner: BrowserWindow, input: unknown): Promise<void> {
    const value = requireNativeTooltip(input)
    const previous = this.entries.get(owner)
    const key = JSON.stringify(value)
    if (previous?.key === key) return
    previous?.dispose()
    if (!value || owner.isDestroyed() || !owner.isVisible()) return
    const zoom = owner.webContents.getZoomFactor()
    const origin = owner.getContentBounds()
    const bounds = { x: Math.round(origin.x + (value.bounds.x - shadowMargin) * zoom),
      y: Math.round(origin.y + (value.bounds.y - shadowMargin) * zoom),
      width: Math.ceil((value.bounds.width + shadowMargin * 2) * zoom), height: Math.ceil((value.bounds.height + shadowMargin * 2) * zoom) }
    const window = new BrowserWindow({ ...bounds, parent: owner, type: 'tooltip', show: false, frame: false,
      transparent: true, backgroundColor: '#00000000', hasShadow: false, focusable: false, skipTaskbar: true,
      resizable: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    preserveWindowAppearance(window)
    window.setIgnoreMouseEvents(true, { forward: true })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.setZoomFactor(zoom)
    const lifecycle: EventEmitter = owner
    const dispose = () => {
      if (this.entries.get(owner)?.window !== window) return
      this.entries.delete(owner)
      for (const event of ['blur', 'hide', 'move', 'resize', 'closed']) lifecycle.removeListener(event, dispose)
      owner.webContents.removeListener('did-start-navigation', dispose)
      if (!window.isDestroyed()) window.destroy()
    }
    this.entries.set(owner, { window, key, dispose })
    for (const event of ['blur', 'hide', 'move', 'resize', 'closed']) lifecycle.on(event, dispose)
    owner.webContents.on('did-start-navigation', dispose)
    window.once('closed', dispose)
    try {
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(tooltipHtml(value))}#anas-native-tooltip`)
      // Pointer-out or owner teardown may win while the tiny surface loads.
      if (this.entries.get(owner)?.window === window) window.showInactive()
    } catch (error) {
      if (this.entries.get(owner)?.window !== window) return
      dispose()
      throw error
    }
  }
}

export const nativeTooltips = new NativeTooltips()

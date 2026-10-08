import { requirePanelBounds, type PanelBounds } from './panels'

// Copy computed values from the shared tooltip component; no second theme/style.
export const tooltipStyleProperties = ['background-color', 'color', 'border', 'border-radius', 'padding', 'box-shadow',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'direction',
  'white-space', 'overflow-wrap', 'word-break'] as const
export interface NativeTooltip {
  label: string
  bounds: PanelBounds
  styles: Record<typeof tooltipStyleProperties[number], string>
}
export interface NativeTooltipApi { setTooltip(value: NativeTooltip | null): Promise<void> }

export function requireNativeTooltip(input: unknown): NativeTooltip | null {
  if (input === null) return null
  const value = input as NativeTooltip
  if (!value || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 8192
    || !value.styles || typeof value.styles !== 'object') throw new Error('Invalid tooltip.')
  const bounds = requirePanelBounds(value.bounds)
  if (!bounds || bounds.width > 2000 || bounds.height > 2000) throw new Error('Invalid tooltip bounds.')
  const styles = {} as NativeTooltip['styles']
  for (const key of tooltipStyleProperties) {
    const text = value.styles[key]
    if (typeof text !== 'string' || text.length > 1024) throw new Error('Invalid tooltip style.')
    styles[key] = text
  }
  return { label: value.label, bounds, styles }
}

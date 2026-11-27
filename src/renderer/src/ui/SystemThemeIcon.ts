import { createLucideIcon } from 'lucide-react'

// Use smooth geometry for the supplied half-filled circle at small UI sizes.
export const SystemThemeIcon = createLucideIcon('SystemTheme', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'outline' }],
  ['path', { d: 'M12 3a9 9 0 0 1 0 18Z', fill: 'currentColor', stroke: 'none', key: 'half' }]
])

export const PROJECT_ICON_NAMES = [
  'folder',
  'message-circle',
  'circle-dollar-sign',
  'book-open',
  'graduation-cap',
  'pencil',
  'pen-tool',
  'braces',
  'square-terminal',
  'music',
  'popcorn',
  'satellite',
  'palette',
  'stethoscope',
  'flower',
  'briefcase',
  'chart',
  'cooking-pot',
  'dumbbell',
  'notebook',
  'scale',
  'globe',
  'plane',
  'wrench',
  'paw-print',
  'flask',
  'brain',
  'heart',
  'sprout',
  'gamepad'
] as const

export type ProjectIconName = typeof PROJECT_ICON_NAMES[number]

export const DEFAULT_PROJECT_ICON: ProjectIconName = 'folder'

export const PROJECT_ICON_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink'
] as const

export type ProjectIconColor = typeof PROJECT_ICON_COLORS[number]

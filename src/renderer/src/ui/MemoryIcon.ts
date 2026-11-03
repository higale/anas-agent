import { createLucideIcon } from 'lucide-react'

export const MemoryIcon = createLucideIcon('Memory', [
  ['path', { d: 'M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3M19 9h3m-3 6h3', key: 'pins' }],
  ['rect', { x: '5', y: '5', width: '14', height: '14', rx: '2', key: 'chip' }],
  ['path', { d: 'M9 10h6m-6 4h6', key: 'rows' }]
])

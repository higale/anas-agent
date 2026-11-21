import { AppWindow, BookMarked, BookOpen, FileDiff, type LucideIcon } from 'lucide-react'
import type { BuiltinPanel } from '@shared/panels'
import { MemoryIcon } from '../MemoryIcon'

type PanelKind = Exclude<BuiltinPanel['kind'], 'subagent'>

const icons = {
  memory: MemoryIcon,
  projectMemory: BookMarked,
  processes: AppWindow,
  document: BookOpen,
  files: FileDiff
} satisfies Record<PanelKind, LucideIcon>

export function BuiltinPanelIcon({ kind, size = 16 }: { kind: PanelKind; size?: number }) {
  const Icon = icons[kind]
  return <Icon size={size} />
}

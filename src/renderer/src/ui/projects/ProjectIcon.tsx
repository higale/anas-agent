import {
  BookOpen,
  Brain,
  Braces,
  BriefcaseBusiness,
  ChartNoAxesColumnIncreasing,
  CircleDollarSign,
  CookingPot,
  Dumbbell,
  FlaskConical,
  Flower2,
  FolderKanban,
  Gamepad2,
  Globe2,
  GraduationCap,
  Heart,
  House,
  MessageCircle,
  Music2,
  NotebookTabs,
  Palette,
  PawPrint,
  PenTool,
  Pencil,
  Plane,
  Popcorn,
  Satellite,
  Scale,
  Sprout,
  SquareTerminal,
  Stethoscope,
  Wrench,
  createLucideIcon
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ProjectIconColor, ProjectIconName } from '@shared/types'
import { IconImage } from '../IconImage'
import { DEFAULT_PROJECT_ICON } from '@shared/projectAppearance'

const Pineapple = createLucideIcon('Pineapple', [
  ['path', { d: 'm9 9-3-5 4 2 2-4 2 4 4-2-3 5', key: 'crown' }],
  ['rect', { x: '6', y: '8', width: '12', height: '14', rx: '6', key: 'fruit' }],
  ['path', { d: 'm8 11 8 8m-9-3 5 5m4-10-8 8m9-3-5 5', key: 'texture' }]
])

const projectIcons: Record<ProjectIconName, LucideIcon> = {
  folder: FolderKanban,
  'message-circle': MessageCircle,
  'circle-dollar-sign': CircleDollarSign,
  'book-open': BookOpen,
  'graduation-cap': GraduationCap,
  pencil: Pencil,
  'pen-tool': PenTool,
  braces: Braces,
  'square-terminal': SquareTerminal,
  music: Music2,
  popcorn: Popcorn,
  satellite: Satellite,
  palette: Palette,
  stethoscope: Stethoscope,
  flower: Flower2,
  briefcase: BriefcaseBusiness,
  chart: ChartNoAxesColumnIncreasing,
  'cooking-pot': CookingPot,
  dumbbell: Dumbbell,
  notebook: NotebookTabs,
  scale: Scale,
  globe: Globe2,
  plane: Plane,
  wrench: Wrench,
  'paw-print': PawPrint,
  flask: FlaskConical,
  brain: Brain,
  heart: Heart,
  sprout: Sprout,
  gamepad: Gamepad2,
  pineapple: Pineapple,
  house: House
}

interface ProjectIconProps {
  iconData?: string
  emoji?: string
  className?: string
  color?: ProjectIconColor
  icon?: ProjectIconName
  size: number
}

export function ProjectIcon({ className, color, icon, iconData, emoji, size }: ProjectIconProps) {
  if (iconData) return <IconImage data={iconData} size={size} className={className} />
  if (emoji) return <span className={`project-emoji${className ? ` ${className}` : ''}`} aria-hidden="true"
    style={{ width: size, height: size, fontSize: size }}>{emoji}</span>
  const Icon = projectIcons[icon ?? DEFAULT_PROJECT_ICON]

  return (
    <Icon
      className={className}
      data-project-icon-color={color}
      size={size}
      style={color ? { color: `var(--project-icon-${color})` } : undefined}
    />
  )
}

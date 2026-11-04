import { IconImage } from '../IconImage'
import { ServerCog } from 'lucide-react'

interface ProviderIconProps {
  iconData?: string
  size?: number
}

export function ProviderIcon({ iconData, size = 18 }: ProviderIconProps) {
  return iconData
    ? <IconImage data={iconData} size={size} />
    : <ServerCog aria-hidden="true" className="provider-icon" size={size} />
}

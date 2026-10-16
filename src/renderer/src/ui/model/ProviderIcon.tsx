import { ServerCog } from 'lucide-react'

interface ProviderIconProps {
  iconData?: string
  size?: number
}

export function ProviderIcon({ iconData, size = 18 }: ProviderIconProps) {
  return iconData
    ? <img className="provider-icon" src={iconData} alt="" width={size} height={size} draggable={false} />
    : <ServerCog aria-hidden="true" className="provider-icon" size={size} />
}

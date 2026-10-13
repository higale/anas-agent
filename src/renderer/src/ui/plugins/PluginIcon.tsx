import { useState } from 'react'
import { Puzzle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PluginIconSources } from '@shared/plugins'

function IconImage({ src, size, monochrome, onError }: { src: string; size: number; monochrome: boolean; onError?(): void }) {
  const [failed, setFailed] = useState(false)
  const { t } = useTranslation()
  if (failed) return <span data-tooltip={t('plugins.icon_failed')}><Puzzle size={size} /></span>
  const image = <img src={src} width={size} height={size} alt="" draggable={false}
    onError={() => { setFailed(true); onError?.() }} />
  return monochrome ? <span className="plugin-icon-mask" style={{ maskImage: `url(${JSON.stringify(src)})` }}>{image}</span> : image
}

/** Images stay in an img element; SVG content never enters the host document. */
export function PluginIcon({ icon, size = 16, monochrome = false, onError }: { icon?: PluginIconSources; size?: number; monochrome?: boolean; onError?(): void }) {
  return <span className="plugin-icon" style={{ width: size, height: size }} aria-hidden="true">
    {!icon ? <Puzzle size={size} /> : icon.light === icon.dark
      ? <IconImage key={icon.light} src={icon.light} size={size} monochrome={monochrome} onError={onError} />
      : <>
          <span className="plugin-icon-light"><IconImage key={icon.light} src={icon.light} size={size} monochrome={monochrome} onError={onError} /></span>
          <span className="plugin-icon-dark"><IconImage key={icon.dark} src={icon.dark} size={size} monochrome={monochrome} onError={onError} /></span>
        </>}
  </span>
}

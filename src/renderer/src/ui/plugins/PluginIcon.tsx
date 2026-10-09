import { useState } from 'react'
import { Puzzle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PluginIconSources } from '@shared/plugins'

function IconImage({ src, size, onError }: { src: string; size: number; onError?(): void }) {
  const [failed, setFailed] = useState(false)
  const { t } = useTranslation()
  return failed
    ? <span data-tooltip={t('plugins.icon_failed')}><Puzzle size={size} /></span>
    : <img src={src} width={size} height={size} alt="" draggable={false}
        onError={() => { setFailed(true); onError?.() }} />
}

/** Images stay in an img element; SVG content never enters the host document. */
export function PluginIcon({ icon, size = 16, onError }: { icon?: PluginIconSources; size?: number; onError?(): void }) {
  return <span className="plugin-icon" style={{ width: size, height: size }} aria-hidden="true">
    {!icon ? <Puzzle size={size} /> : icon.light === icon.dark
      ? <IconImage key={icon.light} src={icon.light} size={size} onError={onError} />
      : <>
          <span className="plugin-icon-light"><IconImage key={icon.light} src={icon.light} size={size} onError={onError} /></span>
          <span className="plugin-icon-dark"><IconImage key={icon.dark} src={icon.dark} size={size} onError={onError} /></span>
        </>}
  </span>
}

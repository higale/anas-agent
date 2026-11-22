import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { McpToolStatus } from '@shared/types'
import { contentServices } from '../panels/contentServices'

/** Transient connection state beside the original running tool, including collapsed activity groups. */
export function McpStartupLabel({ toolName }: { toolName: string }) {
  const { t } = useTranslation()
  const [name, setName] = useState<string>()
  useEffect(() => {
    let disposed = false, updated = false
    const update = (status: McpToolStatus | null) => {
      if (!disposed) setName(status?.servers.find(server => ['starting', 'recovering'].includes(server.state)
        && server.toolNames.includes(toolName))?.name)
    }
    const api = contentServices().mcp
    const unsubscribe = api.onStatus(status => { updated = true; update(status) })
    void api.status().then(status => { if (!updated) update(status) }).catch(() => undefined)
    return () => { disposed = true; unsubscribe() }
  }, [toolName])
  return name ? <small role="status">· {t('agent.mcp_starting', { name })}</small> : null
}

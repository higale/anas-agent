import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginSummary } from '@shared/plugins'
import { errorDetail } from '@shared/recovery'

export function usePlugins(closeViews: (ids: string[] | 'all') => void) {
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [error, setError] = useState<string>()
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++revision.current
    try {
      const next = await window.gale.plugins.list()
      if (request === revision.current) { setPlugins(next); setError(undefined) }
    } catch (reason) {
      if (request === revision.current) setError(errorDetail(reason))
    }
  }, [])
  useEffect(() => {
    void refresh()
    const unsubscribe = window.gale.plugins.onChanged(ids => { if (ids) closeViews(ids); void refresh() })
    return () => { revision.current++; unsubscribe() }
  }, [refresh, closeViews])
  return { plugins, error, refresh }
}

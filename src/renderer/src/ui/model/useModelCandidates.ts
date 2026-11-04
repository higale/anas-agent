import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { missingModelApiKeyEnvironmentVariable } from '@shared/modelConfig'
import { notice } from '../notice'
import { buildModelListRequest, type ModelDraft } from './modelDraft'

export function useModelCandidates(draft: ModelDraft, enabled: boolean, t: TFunction) {
  const { providerId, baseUrl, name, modelListUrl, protocol, apiKey } = draft
  const request = useMemo(() => buildModelListRequest({ providerId, baseUrl, name, modelListUrl, protocol, apiKey }),
    [providerId, baseUrl, name, modelListUrl, protocol, apiKey])
  const [modelCandidates, setCandidates] = useState<string[]>([])
  const [modelListLoading, setLoading] = useState(false)
  const generation = useRef(0)

  useLayoutEffect(() => {
    const id = ++generation.current
    setCandidates([])
    setLoading(false)
    async function loadCache() {
      if (!enabled || !request) return
      try {
        const result = await window.gale.config.getCachedModels(request)
        if (generation.current === id) setCandidates(result?.models ?? [])
      } catch { /* A cache miss leaves the list empty. */ }
    }
    void loadCache()
    return () => { generation.current++ }
  }, [enabled, request])

  async function refreshModelCandidates(): Promise<void> {
    if (!enabled) return
    if (!request) {
      notice.error(t('settings.base_url_required_for_models'))
      return
    }
    const id = ++generation.current
    setLoading(true)
    try {
      const result = await window.gale.config.fetchModels(request)
      if (generation.current !== id) return
      setCandidates(result.models)
      notice.success(t('settings.model_list_refreshed'))
    } catch (reason) {
      if (generation.current !== id) return
      setCandidates([])
      const missing = missingModelApiKeyEnvironmentVariable(reason)
      notice.error(missing ? t('settings.api_key_variable_missing', { name: missing }) : t('settings.failed_fetch_model_list'))
    } finally {
      if (generation.current === id) setLoading(false)
    }
  }

  return { modelCandidates, modelListLoading, refreshModelCandidates }
}

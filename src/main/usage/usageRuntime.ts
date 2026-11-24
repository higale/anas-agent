import { normalizeUsageSettings } from '@shared/usageMeter'
import type { AppConfigSnapshot } from '@shared/types'
import { getAppConfigSnapshot, onAppConfigChanged, updateUsageDisplayMode } from '../config/appConfig'
import { resolveModelApiKey } from '../config/apiKeys'
import { resolveConfiguredLanguage } from '../languageStore'
import { runApplicationDataOperation } from '../applicationDataLifecycle'
import { handleMainIpc } from '../ipcSecurity'
import { flattenProviderModels } from '@shared/modelConfig'
import { createUsageService } from './usageService'

const service = createUsageService()
let generation = 0
function usageModels(config: AppConfigSnapshot) {
  return flattenProviderModels(config.providers).map(model => {
    let apiKey: string | undefined
    try { apiKey = resolveModelApiKey(model) } catch { /* Missing model keys must not block independent account queries. */ }
    return { ...model, apiKey, usage: config.providers.find(provider => provider.id === model.providerId)?.usage }
  })
}
export function clearUsageRuntime(): void { generation++; service.clear() }
export function registerUsageIpc(): void {
  onAppConfigChanged(change => {
    if (change.config !== 'models') return
    try { service.reconcile(usageModels(change.snapshot)) }
    catch { service.clear() }
  })
  handleMainIpc('usage:setDisplayMode', (_event, providerId: string, mode: 'compact' | 'detailed') =>
    runApplicationDataOperation(() => updateUsageDisplayMode(providerId, mode)))
  handleMainIpc('usage:read', async (_event, modelId: string, refresh = false, presentationOnly = false) => {
    if (typeof modelId !== 'string' || modelId.length > 200 || typeof refresh !== 'boolean' || typeof presentationOnly !== 'boolean') throw new Error('Invalid usage request.')
    const started = generation
    const prepared = await runApplicationDataOperation(async () => {
      const config = await getAppConfigSnapshot()
      const model = usageModels(config).find(item => item.id === modelId)
      if (!model) return
      const language = (await resolveConfiguredLanguage(config.settings.language)).code
      return { model, language }
    })
    // Restore/quit may have cleared the runtime while configuration was loading.
    if (!prepared || started !== generation) return null
    // Network work must not hold the application-data lock needed by restore.
    const result = await service.read(prepared.model, prepared.language, refresh, presentationOnly)
    if (started !== generation) return null
    return runApplicationDataOperation(async () => {
      const models = usageModels(await getAppConfigSnapshot())
      service.reconcile(models)
      const latest = models.find(item => item.id === modelId)
      const querySettings = (model: typeof prepared.model) => {
        const { displayMode: _display, ...settings } = normalizeUsageSettings(model.usage, model.baseUrl)
        return JSON.stringify(settings)
      }
      return latest && latest.model === prepared.model.model && latest.baseUrl === prepared.model.baseUrl && latest.apiKey === prepared.model.apiKey
        && querySettings(latest) === querySettings(prepared.model) ? result : null
    })
  })
}

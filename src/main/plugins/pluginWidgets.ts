import { requirePluginWidgetContent, widgetMatchesModel } from '@shared/pluginWidgets'
import { getAppConfigSnapshot, findResolvedModelConfig } from '../config/appConfig'
import { resolveModelApiKey } from '../config/apiKeys'
import { resolveConfiguredLanguage } from '../languageStore'
import type { PluginStore } from './pluginStore'
import type { PluginBackends } from './pluginBackend'
import { runApplicationDataOperation } from '../applicationDataLifecycle'

/** Only identifiers cross from the renderer; connection details are resolved here. */
export async function readPluginWidget(store: PluginStore, backends: PluginBackends, id: string, widgetId: unknown, modelConfigId: unknown, action: unknown) {
  if (typeof widgetId !== 'string' || (modelConfigId !== undefined && (typeof modelConfigId !== 'string' || modelConfigId.length > 200))
    || (action !== undefined && typeof action !== 'string')) throw new Error('Invalid widget request.')
  const request = await runApplicationDataOperation(async () => {
    const config = await getAppConfigSnapshot()
    const model = findResolvedModelConfig(config, modelConfigId as string | undefined)
    const language = (await resolveConfiguredLanguage(config.settings.language)).code
    return store.exclusive(async () => {
      const manifest = await store.requireEnabled(id)
      const widget = manifest.widgets?.find(item => item.id === widgetId)
      if (!widget) throw new Error('Plugin widget is not declared.')
      if (action !== undefined && !widget.actions.includes(action as string)) throw new Error('Plugin widget action is not declared.')
      if (!widgetMatchesModel(widget, model?.baseUrl) || !backends.canStartAutomatically(id)) return null
      const resolvedModel = model ? { ...model, apiKey: resolveModelApiKey(model) } : undefined
      return { widget, model: resolvedModel, language, prepared: await backends.prepare(id) }
    })
  })
  if (!request) return null
  await request.prepared.ready
  const { model, language } = request
  // Do not retain the application data lock while waiting on plugin/network work.
  // Backup/restore must be able to stop a backend even if its handler is unresponsive.
  const { result } = await runApplicationDataOperation(() => store.exclusive(async () => {
    await store.requireEnabled(id)
    if (!backends.canStartAutomatically(id)) return { result: Promise.resolve(null) }
    return { result: backends.call(id, request.widget.handler, {
      language, action: action ?? null,
      model: model ? { id: model.id, model: model.model, providerId: model.providerId, providerName: model.providerName,
        baseUrl: model.baseUrl, apiKey: model.apiKey ?? '' } : null
    }, request.prepared, undefined, { concurrent: true }) }
  }))
  return requirePluginWidgetContent(await result)
}

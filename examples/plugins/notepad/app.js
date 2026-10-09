/* global anas, document, window */
const draft = document.querySelector('#draft')
const save = document.querySelector('#save')
const status = document.querySelector('#status')
const warning = document.querySelector('#language-warning')
let resources = {}
let language = 'en'
let statusKey = ''
let refreshing = false
let saving = Promise.resolve()

// Static text only. Use i18next for interpolation, plurals, or richer messages.
function t(key) {
  for (const code of [language, 'en']) {
    const value = key.split('.').reduce((value, part) => value?.[part], resources[code])
    if (typeof value === 'string' && value.trim()) return value
  }
  return key
}
function setStatus(key) { statusKey = key; status.textContent = t(key) }
function showError(error) { statusKey = ''; status.textContent = error.message }
async function syncInfo() {
  if (refreshing) return
  refreshing = true
  try {
    const info = await anas.getInfo()
    const codes = Object.keys(resources)
    const preference = info.language.trim().toLowerCase()
    language = codes.find(code => code.toLowerCase() === preference)
      ?? codes.find(code => code.split('-')[0].toLowerCase() === preference.split('-')[0]) ?? 'en'
    document.documentElement.lang = language
    document.documentElement.style.colorScheme = info.theme
    document.documentElement.style.fontSize = `${info.fontSize}px`
    document.title = t('plugin.name')
    document.querySelector('label').textContent = t('plugin.name')
    save.textContent = t('actions.save')
    warning.textContent = t('errors.languages')
    if (statusKey) status.textContent = t(statusKey)
  } finally { refreshing = false }
}
async function start() {
  if (typeof anas.getLanguageResources !== 'function') throw new Error('Please update Anas to use this multilingual example.')
  const languages = await anas.getLanguageResources()
  resources = languages.resources
  warning.hidden = languages.errors.length === 0
  warning.title = languages.errors.join('\n')
  await syncInfo()
  const page = await anas.getContext()
  draft.value = page.restoreState?.draft ?? await anas.data.get('draft') ?? ''
  statusKey = page.restoreState?.statusKey ?? ''
  anas.registerLifecycle({
    async prepare({ signal }) { await saving; signal.throwIfAborted(); return { draft: draft.value, statusKey, scroll: draft.scrollTop }; },
    async activate() { draft.scrollTop = page.restoreState?.scroll ?? 0; },
    async resume() {},
    async dispose() {}
  })
  draft.disabled = false
  save.disabled = false
  draft.addEventListener('input', () => setStatus('status.unsaved'))
  save.addEventListener('click', async () => {
    const value = draft.value
    save.disabled = true
    try {
      saving = anas.data.set('draft', value)
      await saving
      setStatus(draft.value === value ? 'status.saved' : 'status.unsaved')
    } catch (error) { showError(error) }
    finally { saving = Promise.resolve(); save.disabled = false }
  })
  await anas.ready()
  // Refresh presentation without reloading the page or replacing the draft.
  const refresh = () => { if (!document.hidden) void syncInfo().catch(showError) }
  window.addEventListener('focus', refresh)
  const timer = setInterval(refresh, 5000)
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
}
start().catch(error => { showError(error); void anas.failed() })

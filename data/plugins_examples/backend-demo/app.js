let inFlight = Promise.resolve()
/* global anas, document */
const result = document.querySelector('#result')
for (const id of ['call', 'fail']) document.querySelector(`#${id}`).addEventListener('click', async () => {
  try { inFlight = anas.backend.call(id === 'call' ? 'count' : 'fail', { text: 'Hello' }); result.textContent = JSON.stringify(await inFlight, null, 2) }
  catch (error) { result.textContent = error.message }
})
anas.getInfo().then(info => {
  document.documentElement.style.colorScheme = info.theme
  document.documentElement.style.fontSize = `${info.fontSize}px`
}).catch(error => { result.textContent = error.message })

void anas.getContext().then(async page => {
  result.textContent = page.restoreState?.result ?? ''
  anas.registerLifecycle({
    async prepare({ signal }) { await inFlight.catch(() => undefined); signal.throwIfAborted(); return { result: result.textContent }; },
    async activate() {}, async resume() {}, async dispose() {}
  })
  await anas.ready()
}).catch(async error => { result.textContent = error.message; await anas.failed() })

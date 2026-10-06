/* global anas, document */
const result = document.querySelector('#result')
for (const id of ['call', 'fail']) document.querySelector(`#${id}`).addEventListener('click', async () => {
  try { result.textContent = JSON.stringify(await anas.backend.call(id === 'call' ? 'count' : 'fail', { text: 'Hello' }), null, 2) }
  catch (error) { result.textContent = error.message }
})
anas.getInfo().then(info => {
  document.documentElement.style.colorScheme = info.theme
  document.documentElement.style.fontSize = `${info.fontSize}px`
}).catch(error => { result.textContent = error.message })

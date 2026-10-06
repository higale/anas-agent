/* global anas, document */
const draft = document.querySelector('#draft')
const save = document.querySelector('#save')
const status = document.querySelector('#status')
async function start() {
  const info = await anas.getInfo()
  document.documentElement.style.colorScheme = info.theme
  document.documentElement.style.fontSize = `${info.fontSize}px`
  draft.value = await anas.data.get('draft') ?? ''
  draft.disabled = false
  save.disabled = false
  draft.addEventListener('input', () => { status.textContent = 'Unsaved / 未保存' })
  save.addEventListener('click', async () => {
    const value = draft.value
    save.disabled = true
    try {
      await anas.data.set('draft', value)
      status.textContent = draft.value === value ? 'Saved / 已保存' : 'Unsaved / 未保存'
    } catch (error) { status.textContent = error.message }
    finally { save.disabled = false }
  })
}
start().catch(error => { status.textContent = error.message })

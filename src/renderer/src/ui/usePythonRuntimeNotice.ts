import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { notice } from './notice'

export function usePythonRuntimeNotice(): void {
  const { t } = useTranslation()
  useEffect(() => {
    let disposed = false, shown = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()
    const id = 'python-startup'
    const check = async () => {
      try {
        const status = await window.gale.app.getPythonRuntimeStatus()
        if (disposed) return
        if (status.state === 'idle' || status.state === 'preparing') {
          if (!shown && status.state === 'preparing' && Date.now() - started >= 1000) {
            notice.info(t('startup.python_preparing'), { id, description: '', duration: Infinity })
            shown = true
          }
          timer = setTimeout(() => { void check() }, 500)
        } else if (status.state === 'error') {
          notice.error(t('startup.python_failed'), { id, description: status.error, duration: Infinity })
        } else if (shown) {
          if (status.state === 'ready') notice.success(t('startup.python_ready'), { id, description: '' })
          else notice.dismiss(id)
        }
      } catch (error) {
        if (!disposed) notice.error(t('startup.python_status_failed'), {
          id, description: error instanceof Error ? error.message : String(error)
        })
      }
    }
    void check()
    return () => { disposed = true; clearTimeout(timer); notice.dismiss(id) }
  }, [t])
}

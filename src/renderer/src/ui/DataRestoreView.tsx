import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { errorDetail } from '@shared/recovery'
import type { DataRestoreResult } from '@shared/types'

export function DataRestoreView({ sourcePath, onReload }: { sourcePath: string; onReload(): void }) {
  const { t } = useTranslation()
  const [error, setError] = useState<string>()
  const restoreTask = useRef<Promise<DataRestoreResult> | undefined>(undefined)

  useEffect(() => {
    // Run only after the previous app tree has released its subscriptions and
    // polling effects. StrictMode must subscribe again without restoring twice.
    let active = true
    restoreTask.current ??= window.gale.app.restoreData(sourcePath)
    void restoreTask.current.then(
      () => { if (active) onReload() },
      reason => { if (active) setError(errorDetail(reason)) }
    )
    return () => { active = false }
  }, [sourcePath, onReload])

  return <div className="app-shell sidebar-collapsed workspace ui-window ui-fill">
    <div className="window-drag-layer" aria-hidden="true" />
    <main className="initial-app-gate ui-main">
      {error !== undefined ? <section className="initial-app-status initial-app-status-error" role="alert">
        <strong>{t('settings.failed_restore_data')}</strong>
        <p>{error}</p>
        <button className="ui-button" onClick={onReload}>{t('common.reload')}</button>
      </section> : <div className="initial-app-status" role="status" aria-live="polite">
        <LoaderCircle className="agent-spin" size={22} />
        <strong>{t('settings.restoring_data')}</strong>
      </div>}
    </main>
  </div>
}

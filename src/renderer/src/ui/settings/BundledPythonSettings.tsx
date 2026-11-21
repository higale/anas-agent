import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { errorDetail } from '@shared/recovery'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { notice } from '../notice'
import { UI_ICON_SIZE_MEDIUM } from '../uiConstants'
import { SettingsGroup } from './SettingsGroup'

export function BundledPythonSettings() {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const [resetting, setResetting] = useState(false)

  async function reset() {
    if (resetting) return
    setResetting(true)
    const id = 'python-startup'
    notice.info(t('settings.python_resetting'), { id, description: '', duration: Infinity })
    try {
      await window.gale.app.resetBundledPython()
      notice.success(t('settings.python_reset_success'), { id, description: '' })
    } catch (error) {
      notice.error(t('settings.python_reset_failed'), {
        id, description: errorDetail(error, ''), duration: Infinity
      })
    } finally {
      setResetting(false)
    }
  }

  return <SettingsGroup title={t('settings.bundled_python')}>
    <div className="ui-section-header settings-action-row">
      <div className="ui-field-hint">{t('settings.bundled_python_hint')}</div>
      <button className="ui-button ui-button-compact" type="button" disabled={resetting} onClick={() => setConfirming(true)}>
        <RotateCcw size={UI_ICON_SIZE_MEDIUM} />
        <span>{t(resetting ? 'settings.python_resetting' : 'settings.python_reset')}</span>
      </button>
    </div>
    <ConfirmDialog request={confirming ? {
      title: t('settings.python_reset'), description: t('settings.python_reset_confirm'),
      variant: 'danger', confirmText: t('settings.python_reset'), onConfirm: reset
    } : undefined} onClose={() => setConfirming(false)} />
  </SettingsGroup>
}

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** Mount only while loading; key by resource identity to restart the delay on a switch. */
export function DelayedLoading() {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 150)
    return () => clearTimeout(timer)
  }, [])
  return visible ? <span role="status">{t('common.loading')}</span> : null
}

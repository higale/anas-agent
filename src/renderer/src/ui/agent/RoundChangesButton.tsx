import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { FileDiff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NoFocusButton } from '../NoFocusButton'
import { contentServices } from '../panels/contentServices'
import { RoundChangeAvailabilityStore } from './roundChangeAvailabilityStore'

export function useRoundChangeAvailability(threadId?: string, enabled = false) {
  const store = useMemo(() => threadId && enabled ? new RoundChangeAvailabilityStore(threadId,
    input => contentServices().agent.changes.availability(input)) : undefined, [threadId, enabled])
  useEffect(() => {
    if (!store) return
    store.start()
    const stop = contentServices().agent.onEvent(store.receive, store.synchronize, store.connectionFailed)
    return () => { stop(); store.dispose() }
  }, [store])
  return store
}

export function RoundChangesButton({ runId, store, onOpen }: {
  runId: string; store?: RoundChangeAvailabilityStore; onOpen(runId: string): void
}) {
  const { t } = useTranslation()
  const subscribe = useCallback((listener: () => void) => store?.watch(runId, listener) ?? (() => {}), [store, runId])
  const snapshot = useCallback(() => store?.view(runId) ?? 'loading', [store, runId])
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  if (state === 'empty') return null
  const label = t(state === 'available' ? 'agent.recorded_changes' : state === 'pending' ? 'agent.recorded_changes_pending'
    : state === 'loading' ? 'agent.recorded_changes_loading' : 'agent.recorded_changes_unknown')
  return <NoFocusButton className="ui-tool-button ui-tool-button-muted" type="button" disabled={state !== 'available'}
    aria-label={t('agent.recorded_changes')} data-tooltip={label} onClick={() => onOpen(runId)}><FileDiff size={16} /></NoFocusButton>
}

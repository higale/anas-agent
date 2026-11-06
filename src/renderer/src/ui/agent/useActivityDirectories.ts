import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { contentServices } from '../panels/contentServices'
import { ActivityDirectoryStore } from './activityDirectoryStore'

export function useActivityDirectories(threadId?: string) {
  const store = useMemo(() => new ActivityDirectoryStore(threadId ?? '', {
    directory: input => contentServices().agent.activities.directory(input),
    cancel: id => contentServices().agent.activities.cancel(id)
  }), [threadId])
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  useEffect(() => {
    store.start()
    if (!threadId) return () => store.dispose()
    const stop = contentServices().agent.onEvent(event => {
      const owner = 'run' in event ? event.run.threadId : event.threadId
      const runId = 'run' in event ? event.run.id : 'runId' in event ? event.runId : undefined
      if (owner === threadId && runId) store.invalidate(runId)
    }, store.synchronize, store.connectionFailed)
    return () => { stop(); store.dispose() }
  }, [store, threadId])
  return store
}

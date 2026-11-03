let dispatchTail = Promise.resolve()

/** Preserve click order across send preparation. Only the IPC dispatch is ordered;
 * navigation and later submissions need not wait for the send acknowledgement. */
export function dispatchWorkspaceAction<T>(send: () => Promise<T>, prepare?: () => Promise<void>): Promise<T> {
  const dispatched = dispatchTail.then(async () => {
    if (prepare) await prepare()
    return { reply: send() }
  })
  dispatchTail = dispatched.then(() => undefined, () => undefined)
  return dispatched.then(({ reply }) => reply)
}

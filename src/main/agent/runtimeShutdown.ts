export interface AgentRuntimeShutdownResult {
  drained: boolean
  lingeringRunIds: string[]
  lingeringCallIds: string[]
}

export function validateShutdownTimeout(timeoutMs?: number): void {
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) {
    throw new Error('Agent runtime shutdown timeout must be a non-negative safe integer.')
  }
}

/** A deadline reports ownership still held; it never cancels the drain itself. */
export async function waitForShutdownDrain(drain: Promise<void>, timeoutMs?: number): Promise<boolean> {
  if (timeoutMs === undefined) return drain.then(() => true)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      drain.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref() })
    ])
  } finally { if (timer) clearTimeout(timer) }
}

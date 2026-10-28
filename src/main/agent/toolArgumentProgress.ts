import type { ModelToolInputProgress } from '../../runtime/modelEvents'
import type { AgentToolCallProgress } from '@shared/agentTypes'

const publishIntervalMs = 250

/** Throttle display metadata; never assemble or retain executable arguments. */
export class ToolArgumentProgress {
  private readonly blocks = new Map<number, AgentToolCallProgress>()
  private timer?: ReturnType<typeof setTimeout>
  private dirty = false
  private disposed = false

  constructor(private readonly publish: (progress: AgentToolCallProgress[]) => void) {}

  accept(event: ModelToolInputProgress): void {
    if (this.disposed) return
    const previous = this.blocks.get(event.index)
    // Atomic, non-streamed calls already use the normal completed-message path.
    if (!previous && !event.streamed) return
    this.blocks.set(event.index, {
      index: event.index,
      callId: event.callId ?? previous?.callId,
      name: event.name ?? previous?.name ?? '',
      characterCount: event.characterCount ?? previous?.characterCount ?? 0,
      complete: event.complete
    })
    this.dirty = true
    if (!previous || event.complete) {
      this.flush()
      return
    }
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, publishIntervalMs)
  }

  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    this.publish([...this.blocks.values()].sort((a, b) => a.index - b.index))
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.blocks.clear()
    this.dirty = false
  }
}

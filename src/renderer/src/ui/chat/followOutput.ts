import { createContext } from 'react'

export type FollowOutputState = {
  current: boolean
}

/** The scroll container owns follow intent, including while its layout is hidden. */
export const FollowOutputContext = createContext<FollowOutputState | undefined>(undefined)

type ScrollPanel = Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>

export type FollowOutputPosition = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

type FollowOutputObserverOptions = {
  createObserver?: (callback: ResizeObserverCallback) => Pick<ResizeObserver, 'disconnect' | 'observe'>
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (handle: number) => void
  onResize?: () => void
}

export function isNearScrollBottom(panel: ScrollPanel, threshold = 96): boolean {
  return panel.scrollHeight - panel.scrollTop - panel.clientHeight < threshold
}

export function followOutputPosition(panel: ScrollPanel): FollowOutputPosition {
  return {
    scrollTop: panel.scrollTop,
    scrollHeight: panel.scrollHeight,
    clientHeight: panel.clientHeight
  }
}

export function updateFollowOutputAfterScroll(
  panel: ScrollPanel,
  followOutput: FollowOutputState,
  previousPosition: FollowOutputPosition,
  userInitiated: boolean,
  threshold = 96
): FollowOutputPosition {
  const currentPosition = followOutputPosition(panel)
  // Native anchoring can increase scrollTop while preserving the reading
  // position. A layout-driven scroll must not resume a paused follower.
  const layoutChanged = currentPosition.scrollHeight !== previousPosition.scrollHeight
    || currentPosition.clientHeight !== previousPosition.clientHeight
  if (
    currentPosition.scrollTop < previousPosition.scrollTop
    && userInitiated
  ) {
    followOutput.current = false
  } else if (currentPosition.scrollTop > previousPosition.scrollTop
    && (userInitiated || !layoutChanged) && isNearScrollBottom(panel, threshold)) {
    followOutput.current = true
  }
  return currentPosition
}

export function scrollToFollowOutput(
  panel: ScrollPanel,
  followOutput: FollowOutputState
): boolean {
  if (!followOutput.current) return false
  panel.scrollTop = panel.scrollHeight
  return true
}

export function observeFollowOutputGrowth(
  panel: HTMLElement,
  content: HTMLElement,
  followOutput: FollowOutputState,
  options: FollowOutputObserverOptions = {}
): () => void {
  const createObserver = options.createObserver
    ?? ((callback: ResizeObserverCallback) => new ResizeObserver(callback))
  const requestFrame = options.requestFrame
    ?? ((callback: FrameRequestCallback) => window.requestAnimationFrame(callback))
  const cancelFrame = options.cancelFrame
    ?? ((handle: number) => window.cancelAnimationFrame(handle))
  let frame: number | undefined
  const observer = createObserver(() => {
    if (!followOutput.current && !options.onResize) return
    if (frame !== undefined) return
    frame = requestFrame(() => {
      frame = undefined
      scrollToFollowOutput(panel, followOutput)
      options.onResize?.()
    })
  })

  observer.observe(content)
  observer.observe(panel)

  return () => {
    observer.disconnect()
    if (frame !== undefined) cancelFrame(frame)
  }
}

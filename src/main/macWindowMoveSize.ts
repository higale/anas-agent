import { createRequire } from 'node:module'
import { screen, type BrowserWindow, type Event } from 'electron'
import { runtimeLog } from './runtimeLogger'

interface MoveObservation {
  eventType: number
  eventTimestamp: number
  eventWindow: number
  window: number
  liveResize: boolean
  leftMouseDown: boolean
  inputSequence: string
}
type Observe = (window: BrowserWindow) => MoveObservation | null
const appKitDefined = 13
let nativeObservation: Observe | undefined
const displayEvents = ['display-added', 'display-removed', 'display-metrics-changed'] as const
const displayResets = new Set<() => void>()
const resetDisplayMoves = () => { for (const reset of displayResets) reset() }

function createNativeObservation(): Observe {
  const native = createRequire(import.meta.url)('koffi') as typeof import('koffi').default
  const objc = native.load('/usr/lib/libobjc.A.dylib')
  const cg = native.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
  const getClass = objc.func('objc_getClass', 'void*', ['str'])
  const selector = objc.func('sel_registerName', 'void*', ['str'])
  const pointer = objc.func('objc_msgSend', 'void*', ['void*', 'void*'])
  const integer = objc.func('objc_msgSend', 'long', ['void*', 'void*'])
  const boolean = objc.func('objc_msgSend', 'bool', ['void*', 'void*'])
  const decimal = objc.func('objc_msgSend', 'double', ['void*', 'void*'])
  const counter = cg.func('CGEventSourceCounterForEventType', 'uint32_t', ['int32_t', 'uint32_t'])
  const buttonState = cg.func('CGEventSourceButtonState', 'bool', ['int32_t', 'uint32_t'])
  const application = pointer(getClass('NSApplication'), selector('sharedApplication'))
  const currentEvent = selector('currentEvent'), type = selector('type'), window = selector('window')
  const windowNumber = selector('windowNumber'), inLiveResize = selector('inLiveResize')
  const timestamp = selector('timestamp')
  // Left/right/other mouse down, key down and modifier changes start a new
  // interaction. Counts expose no input contents and require no event tap.
  const inputTypes = [1, 3, 25, 10, 12]
  return owner => {
    // Electron exposes an NSView pointer, not an NSWindow. Both supported Mac
    // architectures use 64-bit pointers and NSInteger; no structures cross FFI.
    const view = owner.getNativeWindowHandle().readBigUInt64LE()
    if (!view) return null
    const target = pointer(view, window), event = pointer(application, currentEvent)
    if (!target || !event) return null
    return {
      eventType: Number(integer(event, type)), eventTimestamp: decimal(event, timestamp), eventWindow: Number(integer(event, windowNumber)),
      window: Number(integer(target, windowNumber)), liveResize: boolean(target, inLiveResize), leftMouseDown: buttonState(0, 0),
      inputSequence: inputTypes.map(type => counter(0, type)).join(':')
    }
  }
}

/** macOS-specific compatibility code, not a general window sizing algorithm.
 * AppKit can restore stale per-screen geometry at the end of a native move.
 * Reproduction, risks and removal criteria: docs/PANEL_FRAMEWORK.md.
 * Never mutate NSWindow or depend on private events. */
export function registerMacWindowMoveSizeGuard(window: BrowserWindow, options: {
  platform?: NodeJS.Platform; observe?: Observe
} = {}): void {
  if ((options.platform ?? process.platform) !== 'darwin') return
  const observe = options.observe ?? (nativeObservation ??= createNativeObservation())
  let move: { inputSequence: string; width: number; height: number; adjustmentTimestamp?: number } | undefined
  const reset = () => { move = undefined }
  const read = () => {
    if (window.isDestroyed()) return null
    try { return observe(window) }
    catch (error) {
      dispose()
      runtimeLog('error', 'window', 'macOS window size protection stopped: native move observation failed.', { error })
      return null
    }
  }
  const moving = () => {
    reset()
    const state = read()
    // will-move identifies this window. NSApp.currentEvent can still belong to a
    // tooltip/menu's nested dispatch here, so it cannot identify the drag start.
    if (state?.leftMouseDown && !state.liveResize) {
      const { width, height } = window.getBounds()
      move = { inputSequence: state.inputSequence, width, height }
    }
  }
  const resizing = (event: Event) => {
    const previous = move
    if (!previous || window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return
    const state = read(), bounds = window.getBounds()
    if (state?.eventType === appKitDefined && state.eventWindow === state.window && !state.liveResize
      && state.inputSequence === previous.inputSequence && bounds.width === previous.width && bounds.height === previous.height
      && (previous.adjustmentTimestamp === undefined || previous.adjustmentTimestamp === state.eventTimestamp)) {
      // AppKit can ask more than once while handling the same move-end event.
      // Preserve all of that event's callbacks, but not a later native event.
      previous.adjustmentTimestamp = state.eventTimestamp
      event.preventDefault()
    } else reset()
  }
  const modeEvents = ['blur', 'hide', 'minimize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const
  const windowEvents: NodeJS.EventEmitter = window, displaySource: NodeJS.EventEmitter = screen
  const dispose = () => {
    reset()
    window.removeListener('will-move', moving)
    window.removeListener('will-resize', resizing)
    window.removeListener('closed', dispose)
    for (const event of modeEvents) windowEvents.removeListener(event, reset)
    displayResets.delete(reset)
    if (!displayResets.size) for (const event of displayEvents) displaySource.removeListener(event, resetDisplayMoves)
  }
  window.on('will-move', moving)
  window.on('will-resize', resizing)
  window.once('closed', dispose)
  for (const event of modeEvents) windowEvents.on(event, reset)
  if (!displayResets.size) for (const event of displayEvents) displaySource.on(event, resetDisplayMoves)
  displayResets.add(reset)
}

import type { ChangeEvent, FocusEvent, InputHTMLAttributes, KeyboardEvent, TextareaHTMLAttributes } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { resizeAutosizeTextarea } from './autosizeTextarea'

interface CommitTextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onBlur' | 'onChange' | 'onKeyDown' | 'type' | 'value'> {
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void
  onCommit: (value: string) => void | Promise<void>
  onDraftChange?: (value: string) => void
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  preserveDirtyDraft?: boolean
  type?: InputHTMLAttributes<HTMLInputElement>['type']
  value: string
}

interface CommitTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onBlur' | 'onChange' | 'value'> {
  onBlur?: (event: FocusEvent<HTMLTextAreaElement>) => void
  onCommit: (value: string) => void | Promise<void>
  onDraftChange?: (value: string) => void
  preserveDirtyDraft?: boolean
  value: string
}

export function CommitTextInput({
  onBlur,
  onCommit,
  onDraftChange,
  onKeyDown,
  preserveDirtyDraft = false,
  value,
  ...props
}: CommitTextInputProps) {
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(value)
  const skipBlurCommitRef = useRef(false)
  const dirtyRef = useRef(false)
  const pendingCommitsRef = useRef(new Set<{ value: string }>())

  useEffect(() => {
    if (preserveDirtyDraft && dirtyRef.current && draftRef.current !== value) return
    draftRef.current = value
    setDraft(value)
    dirtyRef.current = false
  }, [preserveDirtyDraft, value])

  async function commit(): Promise<void> {
    const next = draftRef.current
    const revertingPending = preserveDirtyDraft && [...pendingCommitsRef.current].some(commit => commit.value !== next)
    if (next === value && !revertingPending) return
    const request = { value: next }
    pendingCommitsRef.current.add(request)
    try { await onCommit(next) }
    finally { pendingCommitsRef.current.delete(request) }
  }

  function handleBlur(event: FocusEvent<HTMLInputElement>): void {
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false
    } else {
      void commit()
    }
    onBlur?.(event)
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const nextDraft = event.target.value
    draftRef.current = nextDraft
    dirtyRef.current = true
    setDraft(nextDraft)
    onDraftChange?.(nextDraft)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      skipBlurCommitRef.current = true
      draftRef.current = value
      dirtyRef.current = false
      setDraft(value)
      onDraftChange?.(value)
      event.currentTarget.blur()
      return
    }
    onKeyDown?.(event)
  }

  return (
    <input
      {...props}
      value={draft}
      onBlur={handleBlur}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
    />
  )
}

export function CommitTextarea({
  onBlur,
  onCommit,
  onDraftChange,
  preserveDirtyDraft = false,
  value,
  ...props
}: CommitTextareaProps) {
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(value)
  const savedValueRef = useRef(value)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!preserveDirtyDraft || draftRef.current === savedValueRef.current) {
      draftRef.current = value
      setDraft(value)
    }
    savedValueRef.current = value
  }, [preserveDirtyDraft, value])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea?.classList.contains('ui-autosize-textarea')) return
    resizeAutosizeTextarea(textarea)
  }, [draft])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea?.classList.contains('ui-autosize-textarea')) return
    let width = -1
    let frame = 0
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return
      width = entry.contentRect.width
      cancelAnimationFrame(frame)
      // Measure after layout; height changes must not trigger a resize loop.
      if (width > 0) frame = requestAnimationFrame(() => resizeAutosizeTextarea(textarea))
    })
    observer.observe(textarea)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [props.className])

  function handleBlur(event: FocusEvent<HTMLTextAreaElement>): void {
    if (draftRef.current !== value) void onCommit(draftRef.current)
    onBlur?.(event)
  }

  return (
    <textarea
      {...props}
      ref={textareaRef}
      value={draft}
      onBlur={handleBlur}
      onChange={(event) => {
        const nextDraft = event.target.value
        draftRef.current = nextDraft
        setDraft(nextDraft)
        onDraftChange?.(nextDraft)
      }}
    />
  )
}

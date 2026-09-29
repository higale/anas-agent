import InputNumber from '@rc-component/input-number'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type InputHTMLAttributes } from 'react'

interface CommitNumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>,
  'defaultValue' | 'onBlur' | 'onChange' | 'onInput' | 'onKeyDown' | 'type' | 'value'> {
  integer?: boolean
  normalizeDraft?: (value: string) => string
  onCommit: (value: string) => void | Promise<void>
  onDraftChange?: (value: string) => void
  value: string
}

function formatNumber(value: number | string | undefined): string {
  const [integer, fraction] = String(value ?? '').split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction === undefined ? grouped : `${grouped}.${fraction}`
}

export function CommitNumberInput({
  integer = true,
  normalizeDraft,
  onCommit,
  onDraftChange,
  value,
  ...props
}: CommitNumberInputProps) {
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef(false)
  const formatter = useCallback((number: number | string | undefined) => (
    formatNumber(normalizeDraft?.(String(number ?? '')) ?? number)
  ), [normalizeDraft])

  useEffect(() => {
    draftRef.current = value
    setDraft(value)
  }, [value])

  return (
    <div
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        // The number control normalizes its value before blur bubbles here.
        if (!cancelRef.current && draftRef.current !== value) void onCommit(draftRef.current)
        cancelRef.current = false
      }}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          event.stopPropagation()
          return
        }
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        cancelRef.current = true
        draftRef.current = value
        setDraft(value)
        onDraftChange?.(value)
        inputRef.current?.blur()
      }}
    >
      <InputNumber
        {...props}
        ref={inputRef}
        prefixCls="ui-number-input"
        className={['ui-field', props.className].filter(Boolean).join(' ')}
        inputMode={integer ? 'numeric' : 'decimal'}
        precision={integer ? 0 : undefined}
        formatter={formatter}
        parser={(text) => (text ?? '').replace(/,/g, '')}
        upHandler={<ChevronUp size={12} aria-hidden="true" />}
        downHandler={<ChevronDown size={12} aria-hidden="true" />}
        value={draft === '' ? null : draft}
        onChange={(nextValue) => {
          if (cancelRef.current) return
          const next = String(nextValue ?? '')
          const normalized = normalizeDraft?.(next) ?? next
          draftRef.current = normalized
          // Keep the numeric value distinct so formatting also runs when its normalized value is unchanged.
          setDraft(next)
          onDraftChange?.(normalized)
        }}
        onPressEnter={(event) => {
          event.preventDefault()
          inputRef.current?.blur()
        }}
      />
    </div>
  )
}

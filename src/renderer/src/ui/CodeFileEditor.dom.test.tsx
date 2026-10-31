import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeFileEditor } from './CodeFileEditor'

const runtime = vi.hoisted(() => {
  const release = () => ({ dispose: vi.fn() })
  const createModel = vi.fn((initial: string) => {
    let value = initial
    const listeners = new Set<() => void>()
    return { listeners, getValue: () => value, setValue: vi.fn((next: string) => { value = next; for (const listener of listeners) listener() }), dispose: vi.fn(),
      getOptions: () => ({ bracketPairColorizationOptions: { enabled: false } }), onDidChangeOptions: release }
  })
  const create = vi.fn((_host: unknown, options: { model: ReturnType<typeof createModel> }) => ({
    getModel: () => options.model, saveViewState: () => ({ scrollTop: 120 }), restoreViewState: vi.fn(),
    onDidChangeModelContent: (listener: () => void) => {
      options.model.listeners.add(listener)
      return { dispose: () => options.model.listeners.delete(listener) }
    }, updateOptions: vi.fn(), dispose: vi.fn()
  }))
  return { createModel, create }
})
vi.mock('./diff/monacoRuntime', () => ({ monaco: { editor: runtime }, languageForPath: () => 'plaintext', applyEditorAppearance: () => ({}) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('code file editor lifetime', () => {
  it('does not treat external content refresh as a user edit', async () => {
    const onChange = vi.fn()
    const view = render(<CodeFileEditor path="editable.txt" content="First" onChange={onChange} />)
    await waitFor(() => expect(runtime.create).toHaveBeenCalledTimes(1))
    view.rerender(<CodeFileEditor path="editable.txt" content="Refreshed" onChange={onChange} />)
    expect(onChange).not.toHaveBeenCalled()
    runtime.createModel.mock.results[0].value.setValue('User edit')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('User edit')
  })

  it('does not mount a huge fallback and updates the existing view before disposing its data', async () => {
    const content = 'Large detail\n'.repeat(20000)
    const view = render(<CodeFileEditor path="Activity details" content={content} />)
    expect(view.container.querySelector('pre')).toBeNull()
    expect(screen.getByRole('status')).toBeTruthy()
    await waitFor(() => expect(runtime.create).toHaveBeenCalledTimes(1))
    const model = runtime.createModel.mock.results[0].value
    const editor = runtime.create.mock.results[0].value
    view.rerender(<CodeFileEditor path="Activity details" content={content + 'New output'} />)
    expect(model.getValue()).toBe(content + 'New output')
    expect(runtime.create).toHaveBeenCalledTimes(1)
    expect(editor.restoreViewState).toHaveBeenCalledWith({ scrollTop: 120 })
    view.unmount()
    expect(model.dispose).toHaveBeenCalledOnce()
    expect(editor.dispose).toHaveBeenCalledOnce()
  })

  it('replaces the model and releases the previous file when the resource changes', async () => {
    const view = render(<CodeFileEditor path="first.txt" content="First" />)
    await waitFor(() => expect(runtime.create).toHaveBeenCalledTimes(1))
    const oldModel = runtime.createModel.mock.results[0].value
    view.rerender(<CodeFileEditor path="second.txt" content="Second" />)
    await waitFor(() => expect(runtime.create).toHaveBeenCalledTimes(2))
    expect(oldModel.dispose).toHaveBeenCalledOnce()
    expect(runtime.createModel.mock.results[1].value.getValue()).toBe('Second')
  })
})

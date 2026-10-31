import { useEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import { useTranslation } from 'react-i18next'

export const largeTextThreshold = 128 * 1024

export function CodeFileEditor({ path, content, onChange, wordWrap = true }: {
  path: string; content: string; onChange?(content: string): void; wordWrap?: boolean
}) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<editor.IStandaloneCodeEditor | null>(null)
  const latestContent = useRef(content); latestContent.current = content
  const applyingContent = useRef(false)
  const wrap = useRef(wordWrap)
  wrap.current = wordWrap
  const change = useRef(onChange)
  change.current = onChange
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const editable = Boolean(onChange)
  useEffect(() => {
    let disposed = false
    setReady(false); setError('')
    const cleanups: Array<() => void> = []
    const release = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() }
    void import('./diff/monacoRuntime').then(({ monaco, languageForPath, applyEditorAppearance }) => {
      if (disposed || !host.current) return
      const model = monaco.editor.createModel(latestContent.current, languageForPath(path))
      cleanups.push(() => model.dispose())
      if (!editable) {
        // Monaco reapplies model defaults when language or shared editor settings change.
        const disableBracketColors = () => {
          if (model.getOptions().bracketPairColorizationOptions.enabled) {
            model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } })
          }
        }
        const options = model.onDidChangeOptions(disableBracketColors)
        cleanups.push(() => options.dispose())
        disableBracketColors()
      }
      const editor = monaco.editor.create(host.current, {
        model, readOnly: !editable, domReadOnly: !editable, automaticLayout: true,
        minimap: { enabled: false }, wordWrap: wrap.current ? 'on' : 'off', scrollBeyondLastLine: false,
        lineNumbers: editable ? 'on' : 'off', lineDecorationsWidth: editable ? 10 : 0,
        folding: editable, glyphMargin: false,
        overviewRulerLanes: 0, overviewRulerBorder: false, hideCursorInOverviewRuler: true,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
        contextmenu: false, stickyScroll: { enabled: false }, renderValidationDecorations: 'off',
        unicodeHighlight: { ambiguousCharacters: false, nonBasicASCII: false },
        ...(!editable ? {
          renderLineHighlight: 'none', selectionHighlight: false, occurrencesHighlight: 'off',
          matchBrackets: 'never',
          guides: { indentation: false, highlightActiveIndentation: false, bracketPairs: false,
            bracketPairsHorizontal: false, highlightActiveBracketPair: false },
          hover: { enabled: 'off' }, links: false, colorDecorators: false, codeLens: false,
          inlayHints: { enabled: 'off' }, showUnused: false, showDeprecated: false,
          renderWhitespace: 'none', renderControlCharacters: false,
          unicodeHighlight: { ambiguousCharacters: false, nonBasicASCII: false, invisibleCharacters: false }
        } : {}),
        ariaLabel: path, padding: { top: 12, bottom: 12 }
      })
      instance.current = editor
      cleanups.push(() => { instance.current = null; editor.dispose() })
      const subscription = editor.onDidChangeModelContent(() => { if (!applyingContent.current) change.current?.(model.getValue(undefined, true)) })
      cleanups.push(() => subscription.dispose())
      const appearance = () => editor.updateOptions(applyEditorAppearance())
      appearance()
      const observer = new MutationObserver(appearance)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
      cleanups.push(() => observer.disconnect())
      setReady(true)
    }).catch((reason: unknown) => { release(); if (!disposed) setError(String(reason)) })
    return () => { disposed = true; release() }
  }, [path, editable])
  useEffect(() => {
    const editor = instance.current, model = editor?.getModel()
    if (!editor || !model || model.getValue(undefined, true) === content) return
    const view = editor.saveViewState()
    applyingContent.current = true
    try { model.setValue(content) } finally { applyingContent.current = false }
    editor.restoreViewState(view)
  }, [content])
  useEffect(() => { instance.current?.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' }) }, [wordWrap])
  return <>
    {error && <div role="alert" className="ui-note ui-note-danger">{error}</div>}
    {!ready && (content.length < largeTextThreshold
      ? <pre className="settings-skill-file-content">{content}</pre>
      : !error && <span role="status">{t('common.loading')}</span>)}
    <div className="ui-code-file-editor" data-readonly={!editable} hidden={!ready}>
      <div ref={host} className="ui-code-file-editor-surface" />
    </div>
  </>
}

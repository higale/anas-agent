import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/editor/browser/coreCommands.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/basic-languages/monaco.contribution.js'
import '@monaco/codicon.css'
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

// Local editing, tokenization and diff computation; no editing language services.
jsonDefaults.setModeConfiguration({ tokens: true })
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
export { monaco }
export function languageForPath(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? path
  return monaco.languages.getLanguages().find((language) => language.filenames?.includes(name)
    || language.extensions?.some((extension) => name.toLowerCase().endsWith(extension)))?.id ?? 'plaintext'
}

export function applyEditorAppearance() {
  const root = document.documentElement, styles = getComputedStyle(root)
  const dark = root.dataset.theme === 'dark'
  monaco.editor.defineTheme('anas-code', { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [],
    colors: {
      'editor.background': styles.getPropertyValue('--bg-app').trim(),
      'editor.foreground': styles.getPropertyValue('--text').trim(),
      'editorLineNumber.foreground': styles.getPropertyValue('--text-muted').trim(),
      'editorLineNumber.activeForeground': styles.getPropertyValue('--text').trim(),
      'editorWidget.background': styles.getPropertyValue('--bg-surface').trim(),
      'editorWidget.border': styles.getPropertyValue('--border').trim(),
      'scrollbarSlider.background': styles.getPropertyValue('--scroll-thumb').trim(),
      'scrollbarSlider.hoverBackground': styles.getPropertyValue('--scroll-thumb-hover').trim(),
      'scrollbarSlider.activeBackground': styles.getPropertyValue('--scroll-thumb-hover').trim(),
      'diffEditor.insertedLineBackground': styles.getPropertyValue('--diff-added-line-bg').trim(),
      'diffEditor.insertedTextBackground': styles.getPropertyValue('--diff-added-text-bg').trim(),
      'diffEditor.removedLineBackground': styles.getPropertyValue('--diff-removed-line-bg').trim(),
      'diffEditor.removedTextBackground': styles.getPropertyValue('--diff-removed-text-bg').trim()
    } })
  monaco.editor.setTheme('anas-code')
  return { fontSize: parseFloat(styles.getPropertyValue('--font-size-base')) || 14,
    fontFamily: styles.getPropertyValue('--font-mono').trim() || 'monospace' }
}

import { app } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import manifest from '../../build/python-runtime.json'
import { probePython3, type RuntimeProbeOptions } from './runtimeDiscovery'

// Preserve script-local imports for user tools while ignoring user-installed
// packages and Python environment overrides. Never write bytecode beside code.
export const bundledPythonArgs = ['-E', '-s', '-B', '-X', 'utf8'] as const

export interface BundledPythonInfo {
  executable: string
  version: string
  state: 'available' | 'unavailable'
  documentPackages?: string[]
}

function installedDocumentPackages(root: string): string[] {
  const directory = join(root, 'anas-documents')
  const aliases: Record<string, string> = {
    beautifulsoup4: 'import bs4',
    markitdown: 'selected anas_markitdown converters only',
    pdfminer_six: 'import pdfminer',
    pillow: 'import PIL',
    python_pptx: 'import pptx'
  }
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const match = entry.isDirectory() && /^([\w.]+)-([\w.+!]+)\.dist-info$/.exec(entry.name)
      if (!match) return []
      const [, name, version] = match
      return [`${name} ${version}${aliases[name] ? ` (${aliases[name]})` : ''}`]
    }).sort()
  } catch {
    // An unreadable package inventory does not prevent using the interpreter.
    return []
  }
}

/** App-owned resources only; never discovers, copies or repairs a user runtime. */
export function getBundledPythonInfo(): BundledPythonInfo | undefined {
  if (!app?.getAppPath) return undefined
  const target = `${process.platform}-${process.arch}`
  if (!(target in manifest.targets)) return undefined
  const root = app.isPackaged
    ? join(process.resourcesPath, 'python')
    : join(app.getAppPath(), 'build', 'python-runtime', target, 'python')
  const executable = join(root, process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  const available = existsSync(executable)
  const documentPackages = available ? installedDocumentPackages(root) : []
  return { executable, version: manifest.version, state: available ? 'available' : 'unavailable',
    ...(documentPackages.length ? { documentPackages } : {}) }
}

/** Discover the app-owned interpreter for explicit requests or automatic fallback. */
export async function discoverBundledPython(options: RuntimeProbeOptions = {}) {
  options.signal?.throwIfAborted()
  const info = getBundledPythonInfo()
  return info?.state === 'available' ? probePython3(info.executable, [...bundledPythonArgs], options) : undefined
}

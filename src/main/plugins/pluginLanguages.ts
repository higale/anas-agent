import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginLanguage, PluginLanguageResources, PluginManifest } from '@shared/plugins'
import { isSameOrInsideDirectory, samePath } from '../pathContainment'

const MAX_FILES = 128
const MAX_FILE_BYTES = 128 * 1024
const MAX_TOTAL_BYTES = 512 * 1024
const languageFileName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.json$/i

async function readPluginLanguageFiles(root: string, lang: string): Promise<Record<string, string>> {
  const directory = join(root, lang)
  try {
    const actual = await realpath(directory)
    if (!isSameOrInsideDirectory(root, actual) || samePath(root, actual) || !(await lstat(actual)).isDirectory()) throw new Error('Invalid plugin language directory.')
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw reason
  }
  const entries = (await readdir(directory)).filter(name => /\.json$/i.test(name)).sort()
  if (entries.length > MAX_FILES) throw new Error('Too many plugin language files.')
  const files: Record<string, string> = Object.create(null)
  let bytes = 0
  for (const name of entries) {
    if (name.length > 85 || !languageFileName.test(name)) throw new Error(`Invalid language filename: ${name}`)
    const path = await realpath(join(directory, name))
    if (!isSameOrInsideDirectory(root, path)) throw new Error('Plugin language file leaves its package.')
    const info = await lstat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES || (bytes += info.size) > MAX_TOTAL_BYTES) throw new Error('Plugin language files exceed their size limit.')
    const text = await readFile(path, 'utf8')
    if (Buffer.byteLength(text) !== info.size) throw new Error('Plugin language file changed while reading.')
    files[name] = text
  }
  return files
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function parsePluginLanguages(files: Record<string, string>): PluginLanguageResources & { languages: PluginLanguage[] } {
  const resources: PluginLanguageResources['resources'] = Object.create(null)
  const languages: PluginLanguage[] = []
  const errors: string[] = []
  const codes = new Set<string>()
  for (const [file, text] of Object.entries(files)) {
    try {
      const code = file.slice(0, -5)
      if (codes.has(code.toLowerCase())) throw new Error('Duplicate language code.')
      const raw: unknown = JSON.parse(text)
      if (!object(raw) || raw.version !== 0) throw new Error('Expected language pack v0.')
      // i18next resources are data, not executable markup or host namespaces.
      const validate = (value: unknown, depth = 0): void => {
        if (depth > 24) throw new Error('Language pack is too deeply nested.')
        if (object(value)) for (const [key, child] of Object.entries(value)) {
          if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid language key.')
          validate(child, depth + 1)
        }
        else if (Array.isArray(value)) for (const child of value) validate(child, depth + 1)
      }
      validate(raw)
      const meta = object(raw._meta) ? raw._meta : {}
      const plugin = object(raw.plugin) ? raw.plugin : {}
      const string = (value: unknown, limit: number) => typeof value === 'string' && value.trim() && value.length <= limit ? value.trim() : undefined
      languages.push({ code, name: string(meta.name, 120) ?? code, author: string(meta.author, 120),
        pluginName: string(plugin.name, 120), pluginDescription: string(plugin.description, 2000) })
      resources[code] = raw
      codes.add(code.toLowerCase())
    } catch (reason) { errors.push(`${file}: ${reason instanceof Error ? reason.message : 'Invalid language pack.'}`) }
  }
  return { resources, languages, errors }
}

export async function loadPluginLanguages(root: string, manifest: PluginManifest): Promise<ReturnType<typeof parsePluginLanguages>> {
  if (!manifest.lang) return { resources: {}, languages: [], errors: [] }
  try { return parsePluginLanguages(await readPluginLanguageFiles(root, manifest.lang)) }
  catch (reason) { return { resources: {}, languages: [], errors: [reason instanceof Error ? reason.message : 'Cannot read plugin language packs.'] } }
}

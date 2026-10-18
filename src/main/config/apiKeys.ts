import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EnvFileSnapshot, ModelApiKeyEnvironmentVariable } from '@shared/types'
import { isModelApiKeyEnvironmentNameValid, isModelApiKeyReferenceInvalid, modelApiKeyEnvironmentName } from '@shared/modelConfig'
import { getBundledEnvFile, getEnvFile } from './dataDir'

let envLoaded = false
const dataEnv: Record<string, string> = Object.create(null)

function ensureDataEnvFile(): void {
  const target = getEnvFile()
  if (existsSync(target)) return

  const bundled = getBundledEnvFile()
  if (!existsSync(bundled)) return

  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(bundled, target)
}

function parseEnvContent(content: string): Record<string, string> {
  const parsed: Record<string, string> = Object.create(null)
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue

    const key = trimmed.slice(0, index).trim()
    const rawValue = trimmed.slice(index + 1).trim()
    const value = rawValue.replace(/^['"]|['"]$/g, '')
    parsed[key] = value
  }
  return parsed
}

function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
}

function resetAppliedDataEnv(): void {
  for (const key of Object.keys(dataEnv)) delete dataEnv[key]
}

function applyDataEnv(parsed: Record<string, string>): void {
  for (const [key, value] of Object.entries(parsed)) {
    dataEnv[key] = value
  }
}

function systemEnvValue(key: string): string | undefined {
  const value = process.env[key]
  return typeof value === 'string' ? value : undefined
}

export function loadDataEnv(): Record<string, string> {
  if (envLoaded) return dataEnv

  ensureDataEnvFile()
  const file = getEnvFile()
  const parsed = existsSync(file) ? parseEnvContent(readFileSync(file, 'utf8')) : {}
  resetAppliedDataEnv()
  applyDataEnv(parsed)
  envLoaded = true
  return dataEnv
}

export function reloadDataEnv(): Record<string, string> {
  envLoaded = false
  return loadDataEnv()
}

export function processEnvironment(includeApplicationEnvironment: boolean): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(includeApplicationEnvironment
      ? Object.fromEntries(Object.entries(loadDataEnv()).filter(([, value]) => value.trim()))
      : {})
  }
}

export function readDataEnvFile(): EnvFileSnapshot {
  ensureDataEnvFile()
  const path = getEnvFile()
  return {
    path,
    content: existsSync(path) ? readFileSync(path, 'utf8') : ''
  }
}

export function writeDataEnvFile(content: string): EnvFileSnapshot {
  if (content.includes('\0')) throw new Error('.env content contains an invalid null byte.')
  ensureDataEnvFile()
  const path = getEnvFile()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content.endsWith('\n') || content.length === 0 ? content : `${content}\n`, 'utf8')
  reloadDataEnv()
  return readDataEnvFile()
}

export function missingDataEnvKeys(keys: readonly string[]): string[] {
  const env = loadDataEnv()
  return [...new Set(keys.map((key) => key.trim()).filter(isValidEnvKey))]
    .filter((key) => !env[key]?.trim() && !systemEnvValue(key)?.trim())
}

export function resolveDataEnvValue(key: string): string | undefined {
  const localValue = loadDataEnv()[key]?.trim()
  return localValue || systemEnvValue(key)?.trim()
}

export function resolveModelApiKey(model: { apiKey?: string }): string | undefined {
  const value = model.apiKey?.trim()
  if (!value) return undefined
  if (isModelApiKeyReferenceInvalid(value)) throw new Error('Invalid API key environment reference. Use ${VARIABLE_NAME}.')
  const name = modelApiKeyEnvironmentName(value)
  if (!name) return value
  const resolved = resolveDataEnvValue(name)
  if (!resolved) throw new Error(`API key environment variable ${name} is missing or empty.`)
  return resolved
}

export function listApiKeyEnvironmentVariables(): ModelApiKeyEnvironmentVariable[] {
  const local = reloadDataEnv()
  const names = new Set([...Object.keys(local), ...Object.keys(process.env)])
  return [...names].filter(name => isModelApiKeyEnvironmentNameValid(name) && /key|token|secret/i.test(name)).map(name => {
    const localValue = local[name]?.trim()
    const systemValue = systemEnvValue(name)?.trim()
    const source: ModelApiKeyEnvironmentVariable['source'] = localValue || (!systemValue && Object.hasOwn(local, name))
      ? 'envFile' : 'system'
    return { name, source, hasValue: Boolean(localValue || systemValue) }
  }).sort((left, right) => left.source.localeCompare(right.source) || left.name.localeCompare(right.name))
}

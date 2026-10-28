import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { decodeExecutionValue } from '../runtime/executionValue'

/** Load immutable evidence for current-format repair and unsupported-format rejection. Callers
 * mutate isolated copies; generation and framework imports are not test steps. */
export function readFrozenStorage<Metadata>(name: string): { bytes: Buffer; metadata: Metadata } {
  return readFrozen<Metadata>(name, 'sqlite')
}

function readFrozen<Metadata>(name: string, format: 'sqlite' | 'directory'): { bytes: Buffer; metadata: Metadata } {
  const root = new URL('../main/agent/fixtures/storage/', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL(`${name}.json`, root), 'utf8'))
  const bytes = gunzipSync(readFileSync(new URL(`${name}.${format}.gz`, root)))
  if (manifest.name !== name || ![0, 1].includes(manifest.schemaVersion) || manifest.bytes !== bytes.length
    || (format === 'directory' && manifest.format !== 'directory')
    || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
    throw new Error(`Frozen storage fixture ${name} does not match its manifest.`)
  }
  return { bytes, metadata: decodeExecutionValue(Buffer.from(JSON.stringify(manifest.metadata))) as Metadata }
}

/** Restore the complete original file family, including uncheckpointed WAL,
 * into an empty test directory. No database is opened or rewritten here. */
export function restoreFrozenStorageDirectory<Metadata>(name: string, directory: string): Metadata {
  const { bytes, metadata } = readFrozen<Metadata>(name, 'directory')
  const files = JSON.parse(bytes.toString('utf8')) as Array<{ path: string; data: string }>
  const root = resolve(directory), destinations = new Set<string>()
  const entries = files.map(file => {
    const destination = resolve(root, file.path)
    if (isAbsolute(file.path) || !destination.startsWith(root + sep) || destinations.has(destination)) {
      throw new Error(`Invalid frozen directory entry: ${file.path}`)
    }
    destinations.add(destination)
    return { destination, bytes: Buffer.from(file.data, 'base64') }
  })
  mkdirSync(root, { recursive: true })
  if (readdirSync(root).length) throw new Error('Frozen directory destination must be empty.')
  for (const entry of entries) {
    mkdirSync(dirname(entry.destination), { recursive: true })
    writeFileSync(entry.destination, entry.bytes)
  }
  return metadata
}

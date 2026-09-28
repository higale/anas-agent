import { requireDataVersion } from '@shared/dataVersion'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import settingsDefaults from '../../data/config/settings.json'
import modelDefaults from '../../data/config/models.json'
import subagentDefaults from '../../data/config/subagents.json'
import skillsDefaults from '../../data/config/skills.json'
import mcpDefaults from '../../data/config/mcp_servers.json'
import capabilityDefaults from '../../data/config/capabilities.json'
import { normalizeToolSettings } from '@shared/toolPackages'
import toolsDefaults from '../../data/config/tools.json'
import projectDefaultsDocument from '../../data/config/projects.json'
import { parseCapabilities, parseDefaultCapabilitySettings, serializeCapabilities } from '@shared/agentCapabilities'
import { errorDetail, recoverableAuxiliaryFiles, resettableConfigFiles, type RecoveryFile, type RecoveryFileStatus, type RecoveryRepairResult } from '@shared/recovery'
import { parseInputHistoryStore } from './inputHistoryStore'
import { inspectAvatarRepair, repairAvatarData } from './recoveryAvatar'
import { samePath } from './pathContainment'
import { normalizeAppConfigSnapshot } from './config/appConfig'
import type { RawAppConfig } from './config/rawAppConfig'
import { parseProjectStore } from './projectStore'
import { normalizeSkillsConfig } from './skillsStore'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'
import { inspectProjectStorageRepair, repairProjectStorage } from './recoveryProjectStorage'

const { version: _projectDefaultsVersion, ...projectDefaults } = projectDefaultsDocument
type RecordValue = Record<string, unknown>
const isObject = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const projectCapabilityDefaults = serializeCapabilities(parseCapabilities(capabilityDefaults))
const templates: Record<string, unknown> = {
  'capabilities.json': capabilityDefaults,
  'settings.json': settingsDefaults, 'models.json': modelDefaults, 'subagents.json': subagentDefaults,
  'mcp_servers.json': mcpDefaults, 'skills.json': skillsDefaults, 'tools.json': toolsDefaults
}

class Repair {
  fields: string[] = []
  constructor(readonly file: string) {}
  record(path: string): void {
    this.fields.push(`${this.file}: ${path}`)
    if (this.fields.length > 10_000) throw new Error('Too many repairable fields; review this file manually.')
  }
  replace(object: RecordValue, key: string, fallback: unknown, path: string): void {
    Object.defineProperty(object, key, { value: structuredClone(fallback), enumerable: true, configurable: true, writable: true })
    this.record(path)
  }
  // Walk only schema fields; never rewrite arbitrary provider parameters or
  // match user list entries by position. Valid false, zero and empty lists stay.
  fill(object: RecordValue, defaults: RecordValue, path = ''): void {
    for (const [key, fallback] of Object.entries(defaults)) {
      const field = path ? `${path}.${key}` : key
      const value = object[key]
      const valid = fallback === null ? value === null || typeof value === 'string'
        : Array.isArray(fallback) ? Array.isArray(value)
          : isObject(fallback) ? isObject(value) : typeof value === typeof fallback
      if (!valid) this.replace(object, key, fallback, field)
      else if (isObject(fallback)) this.fill(value as RecordValue, fallback, field)
    }
  }
  choice(object: RecordValue, key: string, values: readonly string[], fallback: string, path: string): void {
    if (!values.includes(object[key] as string)) this.replace(object, key, fallback, `${path}.${key}`)
  }
  number(object: RecordValue, key: string, min: number, max: number, fallback: number, path: string, integer = true): void {
    const value = object[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      this.replace(object, key, fallback, `${path}.${key}`)
    }
  }
  list(value: unknown, path: string): RecordValue[] {
    if (!Array.isArray(value) || value.length > 10_000) throw new Error(`${path}: expected a list of at most 10000 items; no safe item identity can be inferred.`)
    return value.map((item, index) => {
      if (!isObject(item)) throw new Error(`${path}[${index}]: invalid item; cannot infer its identity.`)
      return item
    })
  }
  capabilities(owner: RecordValue, defaults: RecordValue, path: string): void {
    const field = `${path}.capabilities`
    if (!isObject(owner.capabilities)) this.replace(owner, 'capabilities', defaults, field)
    this.validated(owner.capabilities as RecordValue, defaults, parseCapabilities, field)
  }
  // Test each setting in an otherwise valid default document using the actual
  // parser. Recovery must not maintain a second set of accepted modes or IDs.
  validated(object: RecordValue, defaults: RecordValue, validate: (value: RecordValue) => unknown, path = ''): void {
    const checkListSizes = (value: RecordValue, template: RecordValue, path: string): void => {
      for (const [key, fallback] of Object.entries(template)) {
        const field = path ? `${path}.${key}` : key
        const entry = value[key]
        if (Array.isArray(entry) && entry.length > 10_000) throw new Error(`${field}: too many selection items; review this file manually.`)
        if (isObject(entry) && isObject(fallback)) checkListSizes(entry, fallback, field)
      }
    }
    checkListSizes(object, defaults, path)
    validate(defaults)
    const accepts = (value: RecordValue): boolean => {
      try { validate(value); return true } catch { return false }
    }
    if (accepts(object)) return
    for (const [key, fallback] of Object.entries(defaults)) {
      const field = path ? `${path}.${key}` : key
      const validateField = (value: unknown) => validate({ ...defaults, [key]: value })
      if (accepts({ ...defaults, [key]: object[key] })) continue
      if (isObject(object[key]) && isObject(fallback)) {
        this.validated(object[key], fallback, validateField, field)
      } else {
        // Lists without item defaults are one setting. Never invent an ID or
        // infer item defaults by matching positions in the bundled list.
        this.replace(object, key, fallback, field)
      }
    }
    for (const key of Object.keys(object)) {
      if (Object.hasOwn(defaults, key) || accepts({ ...defaults, [key]: object[key] })) continue
      // A rejected field absent from the current defaults has no replacement.
      // Remove it without translating its meaning into another setting.
      delete object[key]
      this.record(path ? `${path}.${key}` : key)
    }
    validate(object)
  }
}

function validateConfig(file: string, value: RecordValue): void {
  requireDataVersion(value, 0, file)
  if (file === 'capabilities.json') { parseDefaultCapabilitySettings(value); return }
  if (file === 'skills.json') { normalizeSkillsConfig(value); return }
  if (file === 'tools.json') { normalizeToolSettings(value); return }
  const raw: RawAppConfig = {
    capabilities: capabilityDefaults,
    settings: structuredClone(settingsDefaults) as RawAppConfig['settings'], providers: [], subagents: structuredClone(subagentDefaults.subagents), mcp_servers: []
  }
  if (file === 'settings.json') {
    // Model references are checked against the actual models separately, not
    // cleared merely because this file is being checked in isolation.
    raw.settings = { ...value, default_model_id: null }
  } else if (file === 'models.json') raw.providers = value.providers as RawAppConfig['providers']
  else if (file === 'subagents.json') raw.subagents = value.subagents as RawAppConfig['subagents']
  else raw.mcp_servers = value.mcp_servers as unknown[]
  normalizeAppConfigSnapshot(raw)
}

export function repairDocument(file: string, input: unknown): { value: RecordValue; fields: string[]; unresolved?: string[] } {
  if (!isObject(input)) throw new Error('Document is not a JSON object; use reset.')
  const value = structuredClone(input)
  const repair = new Repair(file)
  const unresolved: string[] = []
  if (value.version !== 0) {
    repair.replace(value, 'version', 0, 'version')
  }
  if (file === 'input_history.json') {
    repair.number(value, 'maxHistory', 1, Number.MAX_SAFE_INTEGER, 100, 'inputHistory')
    if (Array.isArray(value.items)) {
      const readable = value.items.filter((item, index) => {
        if (isObject(item) && typeof item.text === 'string') return true
        unresolved.push(`${file}: items[${index}] could not be recovered; the original entry is retained in the preservation copy.`)
        return false
      })
      if (unresolved.length) {
        // An entirely unreadable history must not be replaced by an empty one.
        // Mixed files can expose the usable entries after preserving all bytes.
        if (!readable.length) throw new Error(unresolved.join('\n'))
        repair.replace(value, 'items', readable, 'items (recovered readable entries)')
      }
    }
    // Validate with the normal reader, but do not write its pruning/deduplication
    // result during rescue: retain every original entry and its metadata.
    parseInputHistoryStore(value)
  } else if (file === 'projects.json') {
    // Project IDs, kinds, names and timestamps have no recoverable defaults.
    // Never replace a project list or generate IDs behind existing DB records.
    for (const [index, project] of repair.list(value.projects, 'projects').entries()) {
      const path = `projects[${index}]`
      repair.fill(project, { pinned: false, collapsed: false, prompt: projectDefaults.prompt }, path)
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID && project.pinned !== false) repair.replace(project, 'pinned', false, `${path}.pinned`)
      if (project.kind === 'workspace') {
        repair.fill(project, { ...projectDefaults, sourceFolders: [], restrict_subagents: capabilityDefaults.restrict_subagents }, path)
        repair.capabilities(project, projectCapabilityDefaults, path)
      }
    }
    parseProjectStore(value)
  } else {
    if (!templates[file]) throw new Error('Unsupported repair file.')
    repair.fill(value, templates[file] as RecordValue)
    if (file === 'capabilities.json') {
      repair.validated(value, capabilityDefaults, parseDefaultCapabilitySettings)
    } else if (file === 'settings.json') {
      for (const [key, choices] of Object.entries({ theme: ['system', 'light', 'dark'], chat_content_width: ['narrow', 'wide', 'adaptive'],
        diff_view_mode: ['inline', 'side_by_side'], new_thread_model_selection: ['default', 'prompt', 'current'], attachment_text_overflow: ['truncate', 'error'], log_level: ['trace', 'debug', 'info', 'warn', 'error', 'off'] })) {
        repair.choice(value, key, choices, (settingsDefaults as RecordValue)[key] as string, 'settings')
      }
      for (const [key, min, max] of [['font_size', 11, 18], ['sidebar_width', 220, 420], ['workspace_panel_width', 320, Number.MAX_SAFE_INTEGER], ['log_retention_days', 0, 3650],
        ['max_model_calls_per_run', 0, 9999], ['attachment_text_max_chars', 1000, 2_000_000]] as const) {
        repair.number(value, key, min, max, settingsDefaults[key], 'settings')
      }
      repair.number(value.speech_reply as RecordValue, 'speed', 0.25, 4, settingsDefaults.speech_reply.speed, 'speech_reply', false)
    } else if (file === 'subagents.json') {
      for (const [index, agent] of repair.list(value.subagents, 'subagents').entries()) {
        const preset = subagentDefaults.subagents.find((item) => item.preset === agent.preset)
        const path = `subagents[${index}]`
        repair.fill(agent, preset ?? subagentDefaults.subagent_defaults, path)
        repair.capabilities(agent, (preset ?? subagentDefaults.subagent_defaults).capabilities, path)
      }
    } else if (file === 'models.json') {
      for (const [index, provider] of repair.list(value.providers, 'providers').entries()) {
        const path = `providers[${index}]`
        repair.fill(provider, { ...modelDefaults.provider_defaults, models: [], api_key: '', model_list_url: '', model_list_auth: 'bearer' }, path)
        repair.choice(provider, 'model_list_auth', ['bearer', 'anthropic'], 'bearer', path)
        for (const [modelIndex, model] of repair.list(provider.models, `${path}.models`).entries()) {
          const modelPath = `${path}.models[${modelIndex}]`
          repair.fill(model, modelDefaults.model_defaults, modelPath)
          repair.choice(model, 'parameter_preset_mode', ['protocol_default', 'custom', 'none'], modelDefaults.model_defaults.parameter_preset_mode, modelPath)
          repair.number(model, 'max_context_tokens', 2000, Number.MAX_SAFE_INTEGER, modelDefaults.model_defaults.max_context_tokens, modelPath)
          repair.number(model, 'max_output_tokens', 0, Number.MAX_SAFE_INTEGER, modelDefaults.model_defaults.max_output_tokens, modelPath)
          repair.number(model, 'context_compression_threshold', 0.1, 0.95, modelDefaults.model_defaults.context_compression_threshold, modelPath, false)
        }
      }
    } else if (file === 'skills.json') {
      for (const [id, availability] of Object.entries(value.availability as RecordValue)) {
        if (!isObject(availability)) repair.replace(value.availability as RecordValue, id, { model_available: true, user_available: true }, `availability[${JSON.stringify(id)}]`)
        else repair.fill(availability, { model_available: true, user_available: true }, `availability[${JSON.stringify(id)}]`)
      }
      // Directory IDs and paths have no safe replacement; validate rather than
      // inventing new roots or dropping existing directories.
    } else if (file === 'mcp_servers.json') {
      for (const [index, server] of repair.list(value.mcp_servers, 'mcp_servers').entries()) {
        const path = `mcp_servers[${index}]`
        repair.fill(server, { enabled: false, timeout_ms: 30000, args: [], env: {} }, path)
        repair.number(server, 'timeout_ms', 0, Number.MAX_SAFE_INTEGER, 30000, path)
        // Connection endpoints and transport identity are not guessed.
        if (!['stdio', 'http', 'sse'].includes(server.type as string)) throw new Error(`${path}.type: cannot determine the transport; review or reset.`)
        if ((server.args as unknown[]).some((arg) => typeof arg !== 'string') || Object.values(server.env as RecordValue).some((entry) => typeof entry !== 'string')) {
          throw new Error(`${path}: invalid command arguments or environment; no reliable replacement.`)
        }
      }
    }
    validateConfig(file, value)
  }
  return { value, fields: [...new Set(repair.fields)], ...(unresolved.length ? { unresolved } : {}) }
}

interface RepairCandidate { file: RecoveryFile; path: string; before: string | undefined; after: string; fields: string[]; unresolved?: string[] }
export interface RecoveryRepairPlan { candidates: RepairCandidate[]; issues: string[]; files: RecoveryFileStatus[] }

export function requireRecoveryFile(file: unknown): RecoveryFile {
  if (file !== 'projects.json' && !resettableConfigFiles.includes(file as typeof resettableConfigFiles[number])
    && !recoverableAuxiliaryFiles.includes(file as typeof recoverableAuxiliaryFiles[number])) {
    throw new Error('Select exactly one supported file to repair.')
  }
  return file as RecoveryFile
}

async function readRepairFile(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > 16 * 1024 ** 2) throw new Error('Expected a regular file no larger than 16 MiB.')
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function inspectRecoveryRepair(dataDir: string): Promise<RecoveryRepairPlan> {
  const root = await realpath(dataDir)
  const plan: RecoveryRepairPlan = { candidates: [], issues: [], files: [] }
  const documents = new Map<string, RecordValue>()
  for (const file of [...resettableConfigFiles, 'projects.json', ...recoverableAuxiliaryFiles] as const) {
    const auxiliary = recoverableAuxiliaryFiles.includes(file as typeof recoverableAuxiliaryFiles[number])
    const path = file === 'assets/avatar-transform.json' ? join(root, 'assets')
      : file === 'projects.json' || auxiliary ? join(root, file) : join(root, 'config', file)
    const status: RecoveryFileStatus = { name: file, path, repairableFields: [] }
    plan.files.push(status)
    try {
      if (file === 'assets/avatar-transform.json') {
        const avatar = await inspectAvatarRepair(root)
        status.repairableFields = avatar.fields
        if (avatar.issues.length) status.error = avatar.issues.join('\n')
        continue
      }
      // Do not repair through source directory links.
      const parent = await realpath(dirname(path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return dirname(path)
        throw error
      })
      if (!samePath(parent, dirname(path))) throw new Error('Linked configuration directories must be handled manually.')
      const before = await readRepairFile(path)
      // These optional stores are created by their owners when first needed.
      if (before === undefined && auxiliary) continue
      if (before === undefined && file === 'projects.json') throw new Error('Project metadata is missing; use project reset to also clear associated database records.')
      const repaired = repairDocument(file, before === undefined ? {} : JSON.parse(before))
      if (repaired.unresolved?.length) status.error = repaired.unresolved.join('\n')
      if (file === 'projects.json') {
        const storage = await inspectProjectStorageRepair(root, before!, JSON.stringify(repaired.value))
        repaired.fields.push(...storage.fields)
        if (storage.issues.length) status.error = storage.issues.join('\n')
      }
      documents.set(file, repaired.value)
      status.repairableFields = repaired.fields
      if (repaired.fields.length || before === undefined) plan.candidates.push({ file, path, before, after: `${JSON.stringify(repaired.value, null, 2)}\n`, fields: repaired.fields, unresolved: repaired.unresolved })
    } catch (error) { status.error = errorDetail(error) }
  }
  if (['settings.json', 'models.json', 'subagents.json', 'mcp_servers.json', 'tools.json'].every((file) => documents.has(file))) {
    try {
      normalizeAppConfigSnapshot({
        capabilities: documents.get('capabilities.json') ?? capabilityDefaults,
        settings: documents.get('settings.json') as RawAppConfig['settings'],
        providers: documents.get('models.json')!.providers as RawAppConfig['providers'],
        subagents: documents.get('subagents.json')!.subagents as RawAppConfig['subagents'],
        mcp_servers: documents.get('mcp_servers.json')!.mcp_servers as unknown[]
      })
    } catch (error) {
      // Each domain has passed validation above. The remaining cross-domain
      // constraint is settings.default_model_id referencing a configured model.
      plan.files.find((file) => file.name === 'settings.json')!.error = errorDetail(error)
    }
  }
  plan.issues = plan.files.flatMap((file) => file.error ? [`${file.name}: ${file.error}`] : [])
  return plan
}

export async function repairRecoveryData(dataDir: string, file: RecoveryFile, preserve: () => Promise<string>): Promise<RecoveryRepairResult> {
  requireRecoveryFile(file)
  if (file === 'assets/avatar-transform.json') return repairAvatarData(await realpath(dataDir), preserve)
  const plan = await inspectRecoveryRepair(dataDir)
  const candidates = plan.candidates.filter((candidate) => candidate.file === file)
  const result: RecoveryRepairResult = { repaired: [], unresolved: [] }
  if (!candidates.length) {
    result.unresolved = plan.files.filter((status) => status.name === file && status.error).map((status) => `${file}: ${status.error}`)
    if (result.unresolved.length) result.preservationPath = await preserve()
    return result
  }
  if (file === 'projects.json') {
    const candidate = candidates[0]
    Object.assign(result, await repairProjectStorage(dataDir, candidate.before!, candidate.after, preserve))
    result.repaired = candidate.fields
    return result
  }
  result.preservationPath = await preserve()
  for (const candidate of candidates) {
    const temporary = join(dirname(candidate.path), `.${basename(candidate.path)}.${randomUUID()}.tmp`)
    try {
      await mkdir(dirname(candidate.path), { recursive: true })
      if (!samePath(await realpath(dirname(candidate.path)), dirname(candidate.path))) throw new Error('Configuration directory changed while repairing.')
      if (await readRepairFile(candidate.path) !== candidate.before) throw new Error('File changed since inspection; inspect again before repairing.')
      await writeFile(temporary, candidate.after, { flag: 'wx', mode: 0o600 })
      await rename(temporary, candidate.path)
      result.repaired.push(...candidate.fields)
      result.unresolved.push(...(candidate.unresolved ?? []))
    } catch (error) { result.unresolved.push(`${candidate.path}: ${errorDetail(error)}`) }
    finally { await rm(temporary, { force: true }) }
  }
  const verification = await inspectRecoveryRepair(dataDir)
  result.unresolved = [...new Set([...result.unresolved, ...verification.files.flatMap((status) => status.name === file && status.error ? [`${file}: ${status.error}`] : [])])]
  return result
}

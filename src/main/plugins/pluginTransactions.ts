import { lstat, readFile, readdir, realpath, rm, rmdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import fs from 'stubborn-fs'
import { requirePluginId } from '@shared/plugins'
import { writeJsonFileAtomic } from '../atomicJson'
import { samePath } from '../pathContainment'

type Operation = 'replace' | 'remove'
type Phase = 'pending' | 'rolling_back' | 'committed' | 'rolled_back'
export interface PluginTransaction {
  version: 0
  plugin_id: string
  operation: Operation
  had_package: boolean
  move_data: boolean
  phase: Phase
  completed_moves: number
  move_pending: boolean
}
type Location = 'package' | 'incoming' | 'previous' | 'live_data' | 'saved_data'
type Move = readonly [Location, Location]
const journalName = 'transaction.json'

export class PluginTransactionError extends Error {
  constructor(message: string, readonly committed: boolean, cause: unknown) { super(message, { cause }) }
}

function moves(record: PluginTransaction): Move[] {
  return [
    ...(record.had_package ? [['package', 'previous'] as const] : []),
    ...(record.move_data ? [['live_data', 'saved_data'] as const] : []),
    ...(record.operation === 'replace' ? [['incoming', 'package'] as const] : [])
  ]
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), path)) {
      throw new Error(`Plugin transaction directory is linked or invalid: ${path}`)
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function newPluginTransaction(pluginId: string, operation: Operation, hadPackage: boolean, moveData: boolean): PluginTransaction {
  requirePluginId(pluginId)
  return { version: 0, plugin_id: pluginId, operation, had_package: hadPackage, move_data: moveData,
    phase: 'pending', completed_moves: 0, move_pending: false }
}

export async function writePluginTransaction(stage: string, record: PluginTransaction): Promise<void> {
  await writeJsonFileAtomic(join(stage, journalName), record)
}

async function readTransaction(stage: string): Promise<PluginTransaction> {
  const path = join(stage, journalName)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new Error('Invalid plugin transaction journal.')
  const record = JSON.parse(await readFile(path, 'utf8')) as PluginTransaction
  if (!record || record.version !== 0 || typeof record.plugin_id !== 'string'
    || !['replace', 'remove'].includes(record.operation) || !basename(stage).startsWith(`.${record.operation}-`)
    || typeof record.had_package !== 'boolean' || typeof record.move_data !== 'boolean'
    || (!record.had_package && (record.operation === 'remove' || record.move_data))
    || !['pending', 'rolling_back', 'committed', 'rolled_back'].includes(record.phase)
    || !Number.isInteger(record.completed_moves) || typeof record.move_pending !== 'boolean') {
    throw new Error('Invalid plugin transaction journal.')
  }
  requirePluginId(record.plugin_id)
  const length = moves(record).length
  if (record.completed_moves < 0 || record.completed_moves > length
    || record.phase === 'committed' && (record.completed_moves !== length || record.move_pending)
    || record.phase === 'rolled_back' && (record.completed_moves !== 0 || record.move_pending)
    || record.move_pending && (record.phase === 'pending' && record.completed_moves === length
      || record.phase === 'rolling_back' && record.completed_moves === 0)) {
    throw new Error('Invalid plugin transaction progress.')
  }
  return record
}

/** Durable directory moves shared by installation/replacement and removal.
 * The journal records intent before each rename, including reverse moves.
 * Recovery never reruns plugin code or guesses ownership from timestamps. */
export class PluginTransactions {
  constructor(private directory: (group: 'plugins' | 'db/plugins') => Promise<string>) {}

  private async verifyStage(stage: string): Promise<string> {
    const plugins = await this.directory('plugins')
    if (!samePath(join(plugins, basename(stage)), stage)) {
      throw new Error('Plugin transaction is outside its managed directory.')
    }
    return plugins
  }

  private async paths(stage: string, record: PluginTransaction): Promise<Record<Location, string>> {
    const plugins = await this.verifyStage(stage)
    if (!(await directoryExists(stage))) throw new Error('Plugin transaction directory is missing.')
    return {
      package: join(plugins, record.plugin_id), incoming: join(stage, 'incoming'), previous: join(stage, 'previous'),
      live_data: record.move_data && record.phase !== 'committed' && record.phase !== 'rolled_back'
        ? join(await this.directory('db/plugins'), record.plugin_id) : '',
      saved_data: join(stage, 'data')
    }
  }

  private async rename(from: string, to: string): Promise<void> {
    if (!(await directoryExists(from)) || await directoryExists(to)) {
      throw new Error(`Plugin transaction move conflicts with current files: ${from} -> ${to}`)
    }
    await fs.retry.rename({ timeout: 2_000, interval: 25 })(from, to)
  }

  private async validateStage(stage: string, record: PluginTransaction, paths: Record<Location, string>): Promise<void> {
    for (const name of await readdir(stage)) {
      if (![journalName, 'incoming', 'previous', 'data'].includes(name) && !/^\.transaction\.json\..+\.tmp$/.test(name)) {
        throw new Error(`Unexpected plugin recovery file: ${join(stage, name)}`)
      }
    }
    if (record.phase === 'committed' || record.phase === 'rolled_back') {
      for (const [location, allowed] of [
        ['incoming', record.operation === 'replace' && record.phase === 'rolled_back'],
        ['previous', record.had_package && record.phase === 'committed'],
        ['saved_data', record.move_data && record.phase === 'committed']
      ] as const) {
        if (await directoryExists(paths[location]) && !allowed) throw new Error('Plugin recovery files conflict with the completed operation.')
      }
      return
    }
    const expected: Partial<Record<Location, boolean>> = { package: record.had_package,
      incoming: record.operation === 'replace', previous: false, saved_data: false,
      ...(record.move_data ? { live_data: true } : {}) }
    for (const [from, to] of moves(record).slice(0, record.completed_moves)) {
      expected[from] = false
      expected[to] = true
    }
    for (const [location, present] of Object.entries(expected) as [Location, boolean][]) {
      if (await directoryExists(paths[location]) !== present) throw new Error(`Plugin recovery state conflicts with current files: ${paths[location]}`)
    }
  }

  private async reconcileMove(stage: string, record: PluginTransaction, paths: Record<Location, string>): Promise<void> {
    if (!record.move_pending) return
    const reversing = record.phase === 'rolling_back'
    const move = moves(record)[record.completed_moves - (reversing ? 1 : 0)]
    const [from, to] = reversing ? [move[1], move[0]] : move
    const source = await directoryExists(paths[from]), target = await directoryExists(paths[to])
    if (source === target) throw new Error(`Cannot determine interrupted plugin move: ${paths[from]} -> ${paths[to]}`)
    if (target) record.completed_moves += reversing ? -1 : 1
    record.move_pending = false
    await writePluginTransaction(stage, record)
  }

  private async cleanup(stage: string): Promise<void> {
    // Keep the completion record until every other entry has been removed. A
    // crash during cleanup must never turn a committed operation into rollback.
    for (const name of await readdir(stage)) {
      if (name !== journalName) await rm(join(stage, name), { recursive: true, force: true })
    }
    await rm(join(stage, journalName), { force: true })
    await rmdir(stage)
  }

  async recover(stage: string): Promise<void> {
    await this.verifyStage(stage)
    if (!(await directoryExists(stage))) return
    if ((await readdir(stage)).length === 0) { await rmdir(stage); return }
    const record = await readTransaction(stage)
    const paths = await this.paths(stage, record)
    if (record.phase !== 'committed' && record.phase !== 'rolled_back') {
      await this.reconcileMove(stage, record, paths)
      await this.validateStage(stage, record, paths)
      record.phase = 'rolling_back'
      await writePluginTransaction(stage, record)
      while (record.completed_moves > 0) {
        const [from, to] = moves(record)[record.completed_moves - 1]
        record.move_pending = true
        await writePluginTransaction(stage, record)
        await this.rename(paths[to], paths[from])
        record.completed_moves--
        record.move_pending = false
        await writePluginTransaction(stage, record)
      }
      record.phase = 'rolled_back'
      await writePluginTransaction(stage, record)
    }
    await this.validateStage(stage, record, paths)
    await this.cleanup(stage)
  }

  async recoverAll(): Promise<void> {
    const plugins = await this.directory('plugins')
    const failures: Error[] = []
    for (const name of (await readdir(plugins)).sort()) {
      if (!/^\.(?:replace|remove)-/.test(name)) continue
      const stage = join(plugins, name)
      try { await this.recover(stage) } catch (error) {
        failures.push(new Error(`Plugin transaction needs recovery; preserved files remain at ${stage}. ${String(error)}`))
      }
    }
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'))
  }

  async execute(stage: string): Promise<void> {
    await this.verifyStage(stage)
    try {
      const record = await readTransaction(stage)
      if (record.phase !== 'pending' || record.completed_moves !== 0 || record.move_pending) {
        throw new Error('Plugin transaction has already started.')
      }
      const paths = await this.paths(stage, record)
      await this.validateStage(stage, record, paths)
      for (const [from, to] of moves(record)) {
        record.move_pending = true
        await writePluginTransaction(stage, record)
        await this.rename(paths[from], paths[to])
        record.completed_moves++
        record.move_pending = false
        await writePluginTransaction(stage, record)
      }
      record.phase = 'committed'
      await writePluginTransaction(stage, record)
    } catch (error) {
      try { await this.recover(stage) } catch (rollback) {
        throw new PluginTransactionError(`Plugin operation failed; preserved files remain at ${stage}. ${String(error)} ${String(rollback)}`, false, new AggregateError([error, rollback]))
      }
      throw error
    }
    try { await this.cleanup(stage) } catch (error) {
      throw new PluginTransactionError(`Plugin operation completed, but cleanup must be retried at ${stage}. ${String(error)}`, true, error)
    }
  }
}

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { z } from 'zod'
import Database from 'better-sqlite3'
import { getProjectDir } from '../config/dataDir'
import type { MemoryJob, PreferenceDocument, PreferenceFile, PreferenceScope } from '../../shared/preferenceMemory'

export const maximumPreferenceBytes = 16_000
const maximumStateBytes = 16 * 1024 * 1024
const scopeSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('global') }), z.object({ kind: z.literal('project'), projectId: z.string().min(1).max(200) })])
const candidateSchema = z.object({ scope: z.enum(['global', 'project']), intent: z.enum(['remember', 'correct', 'forget']), content: z.string().max(4000), evidence: z.string().max(4000) })
const jobSchema = z.object({
  id: z.string().uuid(), threadId: z.string(), projectId: z.string(), title: z.string(), sourceRevision: z.string(),
  lastRecordId: z.string().min(1), trigger: z.string(), stage: z.enum(['pending', 'extracting', 'consolidating', 'publishing', 'completed', 'failed', 'cancelled']),
  createdAt: z.string(), updatedAt: z.string(), modelId: z.string().optional(), modelName: z.string().optional(), modelFingerprint: z.string().optional(),
  attempts: z.number().int().nonnegative(), retryAt: z.number().optional(), error: z.string().optional(), input: z.string().max(100_000),
  candidates: z.array(candidateSchema).max(50).optional(),
  calls: z.array(z.object({ phase: z.enum(['extract', 'consolidate']), input: z.string().max(200_000), output: z.string().max(100_000).optional(), durationMs: z.number().optional(), inputTokens: z.number().optional(), outputTokens: z.number().optional() })).max(3),
  changes: z.array(z.object({ scope: scopeSchema, before: z.string(), after: z.string() })).max(2)
})
const stateSchema = z.object({ version: z.literal(1), generation: z.string(),
  jobs: z.array(jobSchema) })
type MemoryState = z.infer<typeof stateSchema>
function releaseExhaustedInput(job: MemoryJob): boolean {
  if (job.stage !== 'failed' || job.attempts < 5 || !job.input) return false
  job.input = ''
  return true
}
const journalSchema = z.object({ version: z.literal(1), state: stateSchema, cursors: z.record(z.string(), z.string().nullable()), writes: z.array(z.object({ scope: scopeSchema, beforeHash: z.string(), content: z.string() })) })

export function memoryHash(text: string): string { return createHash('sha256').update(text).digest('hex') }
// Publication journals identify the decoded Markdown body. Editor revisions
// cover the complete source, including an optional UTF-8 signature.
function publicationBaseHash(text: string): string { return memoryHash(text.replace(/^\uFEFF/, '')) }
export function validatePreferenceText(text: string): void {
  if (typeof text !== 'string' || text.includes('\0') || /[\uD800-\uDFFF]/u.test(text) || Buffer.byteLength(text) > maximumPreferenceBytes) throw new Error(`Memory must be valid text within ${maximumPreferenceBytes} UTF-8 bytes.`)
}

/** One metadata owner; Markdown remains the only active preference body. The
 * durable publication journal joins file replacement to job acknowledgement. */
export class PreferenceMemoryStore {
  private state: MemoryState
  private latest?: MemoryJob
  readonly databaseFile: string
  private readonly listeners = new Set<() => void>()

  constructor(readonly dataDir: string, private readonly inspectOnly = false, seedThreads?: () => Iterable<string>) {
    this.databaseFile = join(dataDir, 'db', 'memory.sqlite')
    this.assertPath(this.databaseFile)
    if (inspectOnly && !existsSync(this.databaseFile)) {
      this.state = { version: 1, generation: '', jobs: [] }
      return
    }
    if (!inspectOnly) mkdirSync(dirname(this.databaseFile), { recursive: true })
    this.state = this.database(database => {
      const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()
      if (!tables.length && inspectOnly) return { version: 1, generation: '', jobs: [] }
      if (!tables.length) database.transaction(() => { database.exec(`
        PRAGMA user_version=1;
        CREATE TABLE memory_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), generation TEXT NOT NULL, sources_initialized INTEGER NOT NULL CHECK(sources_initialized IN (0,1)));
        CREATE TABLE memory_sources (thread_id TEXT PRIMARY KEY, last_record_id TEXT, rewind_to TEXT, dirty INTEGER NOT NULL DEFAULT 1 CHECK(dirty IN (0,1)));
        CREATE INDEX memory_dirty_threads ON memory_sources(thread_id) WHERE dirty=1;
        CREATE TABLE memory_jobs (id TEXT PRIMARY KEY, position INTEGER NOT NULL, stage TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));
        CREATE TABLE memory_publication (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL CHECK(json_valid(payload)));
      `)
        database.prepare('INSERT INTO memory_meta VALUES (1,1,?,0)').run(randomUUID())
      })()
      database.prepare('SELECT last_record_id,rewind_to,dirty FROM memory_sources INDEXED BY memory_dirty_threads WHERE dirty=1 AND thread_id=?')
      const initialized = database.prepare('SELECT sources_initialized FROM memory_meta WHERE id=1').pluck().get()
      if (initialized !== 0 && initialized !== 1) throw new Error('Invalid memory source initialization state.')
      if (seedThreads && !initialized) {
        database.transaction(() => {
          const seed = database.prepare('INSERT OR IGNORE INTO memory_sources(thread_id) VALUES (?)')
          for (const id of seedThreads()) seed.run(id)
          database.prepare('UPDATE memory_meta SET sources_initialized=1 WHERE id=1').run()
        })()
      }
      return this.load(database)
    })
    if (inspectOnly && !this.state.generation) return
    this.recoverPublication(inspectOnly)
    if (inspectOnly) return
    const pending = this.state.jobs.filter(job => job.stage !== 'completed' && job.stage !== 'cancelled')
    let changed = pending.length !== this.state.jobs.length
    this.state.jobs = pending
    for (const job of pending) {
      if (releaseExhaustedInput(job)) changed = true
      if (job.calls.length || job.candidates || job.changes.length) {
        job.calls = []; delete job.candidates; job.changes = []; changed = true
      }
      if (['extracting', 'consolidating', 'publishing'].includes(job.stage)) {
        job.stage = 'pending'; job.error = undefined; changed = true
      }
    }
    if (changed) this.persist()
  }

  static validateDirectory(dataDir: string): void {
    const store = new PreferenceMemoryStore(dataDir, true)
    store.read({ kind: 'global' })
    const projects = join(dataDir, 'db', 'projects')
    if (existsSync(projects)) for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(projects, entry.name, 'project.json'))) store.read({ kind: 'project', projectId: entry.name })
    }
  }

  private assertPath(path: string): void {
    const root = resolve(this.dataDir), target = resolve(path), rel = relative(root, target)
    if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(root, rel) !== target) throw new Error('Memory path is outside the data directory.')
    let cursor = root
    for (const part of rel.split(sep).filter(Boolean)) {
      cursor = join(cursor, part)
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`Memory path must not be a link: ${cursor}`)
    }
  }

  private database<T>(action: (database: Database.Database) => T): T {
    this.assertPath(this.databaseFile)
    const database = new Database(this.databaseFile, { readonly: this.inspectOnly, fileMustExist: this.inspectOnly })
    try {
      const version = database.pragma('user_version', { simple: true })
      if (version !== 1 && !(version === 0 && !database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' LIMIT 1").get())) throw new Error('Unsupported preference memory database version.')
      return action(database)
    } finally { database.close() }
  }

  private load(database: Database.Database): MemoryState {
    const meta = database.prepare('SELECT version,generation FROM memory_meta WHERE id=1').get() as { version: number; generation: string } | undefined
    if (!meta) throw new Error('Memory metadata is missing; preserve the database before repairing it.')
    const jobs = (database.prepare('SELECT payload FROM memory_jobs ORDER BY position').all() as Array<{ payload: string }>).map(row => JSON.parse(row.payload))
    const state = { ...meta, jobs }
    if (Buffer.byteLength(JSON.stringify(state)) > maximumStateBytes) throw new Error('Memory metadata exceeds the supported size.')
    return stateSchema.parse(state)
  }

  private write(file: string, content: string): void {
    this.assertPath(file)
    mkdirSync(dirname(file), { recursive: true })
    const temporary = join(dirname(file), `.${file.split(/[\\/]/).at(-1)}.${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' })
      const descriptor = openSync(temporary, 'r+')
      try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
      this.assertPath(file)
      renameSync(temporary, file)
    } finally { rmSync(temporary, { force: true }) }
  }

  private persist(cursors: Record<string, string | null> = {}, acknowledgePublication = false): void {
    try {
      if (Buffer.byteLength(JSON.stringify(this.state)) > maximumStateBytes) throw new Error('Memory metadata is full; existing state has been retained.')
      this.database(database => database.transaction(() => {
        database.prepare('UPDATE memory_meta SET generation=? WHERE id=1').run(this.state.generation)
        database.prepare('DELETE FROM memory_jobs WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(this.state.jobs.map(job => job.id)))
        const jobWrite = database.prepare('INSERT INTO memory_jobs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,stage=excluded.stage,payload=excluded.payload WHERE payload<>excluded.payload OR position<>excluded.position')
        this.state.jobs.forEach((job, index) => jobWrite.run(job.id, index, job.stage, JSON.stringify(job)))
        const setCursor = database.prepare('INSERT INTO memory_sources(thread_id,last_record_id) VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET last_record_id=excluded.last_record_id, rewind_to=NULL')
        for (const [thread, cursor] of Object.entries(cursors)) setCursor.run(thread, cursor)
        if (acknowledgePublication) database.prepare('DELETE FROM memory_publication WHERE id=1').run()
      })())
    } catch (error) {
      this.state = this.database(database => this.load(database))
      throw error
    }
    this.changed()
  }
  private changed(): void {
    for (const listener of this.listeners) { try { listener() } catch { /* A display observer cannot undo a durable write. */ } }
  }

  private path(scope: PreferenceScope): string {
    scopeSchema.parse(scope)
    const directory = scope.kind === 'global' ? join(this.dataDir, 'db') : getProjectDir(scope.projectId, this.dataDir)
    const path = join(directory, 'MEMORY.md')
    this.assertPath(path)
    return path
  }

  usage(): { totalBytes: number; hasData: boolean } {
    const files = [join(this.dataDir, 'db/MEMORY.md')]
    const projects = join(this.dataDir, 'db/projects')
    if (existsSync(projects)) for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(projects, entry.name, 'project.json'))) files.push(join(projects, entry.name, 'MEMORY.md'))
    }
    const documentBytes = files.reduce((size, file) => size + (existsSync(file) && lstatSync(file).isFile() ? lstatSync(file).size : 0), 0)
    return { totalBytes: documentBytes + (this.state.jobs.length ? Buffer.byteLength(JSON.stringify(this.state.jobs)) : 0), hasData: documentBytes > 0 || this.state.jobs.length > 0 }
  }

  read(scope: PreferenceScope): PreferenceFile {
    const path = this.path(scope)
    if (!existsSync(path)) return { scope, path, content: '', hash: memoryHash('') }
    if (lstatSync(path).size > maximumPreferenceBytes) throw new Error('Memory document exceeds the context budget; edit it before continuing.')
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path))
    validatePreferenceText(content)
    return { scope, path, content, hash: memoryHash(content) }
  }

  onChanged(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  save(scope: PreferenceScope, baseHash: string, content: string) {
    validatePreferenceText(content)
    this.recoverPublication()
    const document = this.read(scope)
    if (document.hash !== baseHash) return { status: 'conflict' as const, document }
    if (document.content !== content) this.commit(this.state, [{ scope: document.scope, beforeHash: publicationBaseHash(document.content), content }])
    return { status: 'saved' as const, document: this.read(document.scope) }
  }
  jobs(): MemoryJob[] { return structuredClone(this.state.jobs) }
  activity(): MemoryJob | undefined { return structuredClone(this.latest) }
  generation(): string { return this.state.generation }
  cursor(threadId: string, contains?: (recordId: string) => boolean): string | null {
    return this.database(db => {
      const row = db.prepare('SELECT last_record_id,rewind_to FROM memory_sources WHERE thread_id=?').get(threadId) as
        { last_record_id: string | null; rewind_to: string | null } | undefined
      if (!row || row.rewind_to === null || !contains) return row?.last_record_id ?? null
      // The conversation transaction either retained the old record or committed the edit.
      const cursor = row.last_record_id && contains(row.last_record_id) ? row.last_record_id : row.rewind_to || null
      db.prepare('UPDATE memory_sources SET last_record_id=?,rewind_to=NULL WHERE thread_id=?').run(cursor, threadId)
      return cursor
    })
  }
  *dirtyThreads(): Generator<string> {
    const pageSize = 128
    let after = ''
    for (;;) {
      const page = this.database(db => db.prepare('SELECT thread_id FROM memory_sources WHERE dirty=1 AND thread_id>? ORDER BY thread_id LIMIT ?')
        .pluck().all(after, pageSize) as string[])
      yield* page
      if (page.length < pageSize) return
      after = page[page.length - 1]
    }
  }
  stageCursorEdit(threadId: string, previous: string, retained: string | null): void {
    // A non-null intent survives a crash between the conversation and memory commits.
    // The empty string means the edit retains no processed record.
    this.database(db => db.prepare('UPDATE memory_sources SET rewind_to=?,dirty=1 WHERE thread_id=? AND last_record_id=?')
      .run(retained ?? '', threadId, previous))
  }
  markDirty(threadId: string): void {
    this.database(db => db.prepare('INSERT INTO memory_sources(thread_id) VALUES (?) ON CONFLICT(thread_id) DO UPDATE SET dirty=1 WHERE dirty=0').run(threadId))
  }
  finishScan(threadId: string, tail: string | null): void {
    this.database(db => db.prepare('UPDATE memory_sources SET last_record_id=?, rewind_to=NULL, dirty=0 WHERE thread_id=?').run(tail, threadId))
  }
  forgetThread(threadId: string): void {
    this.recoverPublication()
    const jobs = this.state.jobs.filter(job => job.threadId === threadId)
    this.database(db => db.transaction(() => {
      for (const job of jobs) db.prepare('DELETE FROM memory_jobs WHERE id=?').run(job.id)
      db.prepare('DELETE FROM memory_sources WHERE thread_id=?').run(threadId)
    })())
    this.state.jobs = this.state.jobs.filter(job => job.threadId !== threadId)
    if (this.latest?.threadId === threadId) { this.latest = undefined; this.changed() }
  }
  writeForeground(scope: PreferenceScope, content: string, threadId: string, recordId: string): void {
    validatePreferenceText(content)
    this.recoverPublication()
    const previous = this.read(scope)
    const next = structuredClone(this.state)
    next.jobs = next.jobs.filter(job => job.threadId !== threadId)
    this.commit(next, [{ scope, beforeHash: publicationBaseHash(previous.content), content }], { [threadId]: recordId })
  }
  hasPending(threadId: string): boolean { return this.state.jobs.some(job => job.threadId === threadId && !['completed', 'cancelled'].includes(job.stage)) }

  enqueue(input: Pick<MemoryJob, 'threadId' | 'projectId' | 'title' | 'sourceRevision' | 'lastRecordId' | 'input' | 'trigger'>): MemoryJob | undefined {
    this.recoverPublication()
    if (this.hasPending(input.threadId) || !input.lastRecordId) return undefined
    const now = new Date().toISOString()
    const job: MemoryJob = { ...input, id: randomUUID(), stage: 'pending', createdAt: now, updatedAt: now, attempts: 0, calls: [], changes: [] }
    jobSchema.parse(job)
    if (this.state.jobs.filter(job => job.stage !== 'failed').length >= 64) return undefined
    this.state.jobs.push(job)
    this.persist()
    return structuredClone(job)
  }

  update(id: string, patch: Partial<MemoryJob>): void {
    this.recoverPublication()
    const job = this.state.jobs.find(item => item.id === id)
    if (!job) return // Publication recovery may already have acknowledged this job.
    const { calls, changes, candidates, ...queuePatch } = patch
    const current = this.latest?.id === id && patch.stage !== 'extracting' ? this.latest : job
    const updatedAt = new Date().toISOString()
    const detail = jobSchema.parse({ ...current, ...queuePatch, calls: calls ?? current.calls,
      changes: changes ?? current.changes, candidates: candidates ?? current.candidates, id, updatedAt })
    if (queuePatch.stage === 'cancelled') this.state.jobs = this.state.jobs.filter(item => item.id !== id)
    else {
      Object.assign(job, queuePatch, { updatedAt })
      releaseExhaustedInput(job)
    }
    if (Object.keys(queuePatch).length) this.persist()
    if (patch.stage === 'extracting' || this.latest?.id === id) {
      this.latest = detail
      this.changed()
    }
  }

  publish(id: string, generation: string, documents: Array<PreferenceDocument>): void {
    this.recoverPublication()
    if (generation !== this.state.generation) throw new Error('Memory task was invalidated by a user edit.')
    const next = structuredClone(this.state), job = next.jobs.find(item => item.id === id)
    if (!job) return // Already acknowledged or cancelled.
    const writes = documents.map(document => {
      validatePreferenceText(document.content)
      const previous = this.read(document.scope)
      if (previous.hash !== document.hash) throw new Error('Memory changed while consolidation was running. The task will retry with the current document.')
      job.changes.push({ scope: document.scope, before: previous.content, after: document.content })
      return { scope: document.scope, beforeHash: publicationBaseHash(previous.content), content: document.content }
    })
    next.jobs = next.jobs.filter(item => item.id !== id)
    this.commit(next, writes, { [job.threadId]: job.lastRecordId })
    this.latest = { ...(this.latest?.id === id ? this.latest : job), changes: job.changes, stage: 'completed',
      updatedAt: new Date().toISOString(), error: undefined, retryAt: undefined }
    this.changed()
  }

  clear(scopes: PreferenceScope[], barrier: Record<string, string | null>): number {
    this.recoverPublication()
    const next = structuredClone(this.state)
    next.generation = randomUUID()
    next.jobs = []
    const documents = scopes.map(scope => this.read(scope))
    this.commit(next, documents.map(document => ({ scope: document.scope, beforeHash: publicationBaseHash(document.content), content: '' })), barrier)
    this.latest = undefined; this.changed()
    return documents.filter(document => document.content).length
  }

  private commit(state: MemoryState, writes: z.infer<typeof journalSchema>['writes'], cursors: Record<string, string | null> = {}): void {
    this.recoverPublication()
    if (Buffer.byteLength(JSON.stringify(state)) > maximumStateBytes) throw new Error('Memory metadata is full; existing state has been retained.')
    const journal = journalSchema.parse({ version: 1, state, writes, cursors })
    this.database(database => database.prepare('INSERT INTO memory_publication VALUES (1,?)').run(JSON.stringify(journal)))
    this.recoverPublication()
  }

  private recoverPublication(validateOnly = false): void {
    const row = this.database(database => database.prepare('SELECT payload FROM memory_publication WHERE id=1').get()) as { payload: string } | undefined
    if (!row) return
    const journal = journalSchema.parse(JSON.parse(row.payload))
    for (const write of journal.writes) {
      validatePreferenceText(write.content)
      const current = this.read(write.scope)
      if (publicationBaseHash(current.content) !== write.beforeHash && current.content !== write.content) throw new Error('Interrupted memory publication conflicts with a later edit. Preserve memory data before repairing it.')
    }
    if (validateOnly) return
    for (const write of journal.writes) if (this.read(write.scope).hash !== memoryHash(write.content)) this.write(this.path(write.scope), write.content)
    this.state = journal.state
    this.persist(journal.cursors, true)
  }
}

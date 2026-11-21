import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import { basename } from 'node:path'
import type { ProcessIdentity, ProcessSnapshot } from '@shared/processes'

const dependency = createRequire(import.meta.url)
type Info = Omit<ProcessIdentity, 'role'>
type Entry = { pid: number; parentPid: number; name: string }
interface Inspector { list(): Entry[]; inspect(pid: number): Info | undefined; terminate(info: ProcessIdentity): void }
let inspector: Inspector | undefined
let cachedEntries: { time: number; entries: Entry[] } | undefined
function nativeInspector(): Inspector {
  if (inspector) return inspector
  const native = dependency('koffi') as typeof import('koffi').default
  if (process.platform === 'win32') {
    const kernel = native.load('kernel32.dll'), handle = native.pointer('void')
    const bind = (name: string, result: any, args: any[]) => kernel.func('__stdcall', name, result, args)
    const close = bind('CloseHandle', 'int', [handle])
    const error = bind('GetLastError', 'uint32', [])
    const open = bind('OpenProcess', handle, ['uint32', 'int', 'uint32'])
    const times = bind('GetProcessTimes', 'int', [handle, handle, handle, handle, handle])
    const wait = bind('WaitForSingleObject', 'uint32', [handle, 'uint32'])
    const image = bind('QueryFullProcessImageNameW', 'int', [handle, 'uint32', handle, native.inout(native.pointer('uint32'))])
    const stop = bind('TerminateProcess', 'int', [handle, 'uint32'])
    const snapshot = bind('CreateToolhelp32Snapshot', handle, ['uint32', 'uint32'])
    const entry = native.struct({ size: 'uint32', usage: 'uint32', pid: 'uint32', heap: 'uintptr_t', module: 'uint32',
      threads: 'uint32', parentPid: 'uint32', priority: 'int32', flags: 'uint32', executable: native.array('uint16', 260) })
    const first = bind('Process32FirstW', 'int', [handle, native.inout(native.pointer(entry))])
    const next = bind('Process32NextW', 'int', [handle, native.inout(native.pointer(entry))])
    const withProcess = <T>(pid: number, access: number, fn: (value: any) => T): T | undefined => {
      const value = open(access | 0x101000, 0, pid)
      if (!value) { if (error() === 87) return undefined; throw new Error(`Cannot inspect process ${pid} (Win32 ${error()}).`) }
      try { return wait(value, 0) === 0 ? undefined : fn(value) } finally { close(value) }
    }
    const identity = (value: any, pid: number): Info => {
      const birth = Buffer.alloc(8), scratch = Buffer.alloc(8)
      if (!times(value, birth, scratch, scratch, scratch)) throw new Error(`Cannot read process ${pid} identity.`)
      const path = Buffer.alloc(65536), count = [32768]
      if (!image(value, 0, path, count)) throw new Error(`Cannot read process ${pid} executable.`)
      const ticks = birth.readBigUInt64LE()
      return { pid, parentPid: 0, birth: ticks.toString(), startedAt: new Date(Number(ticks / 10000n - 11644473600000n)).toISOString(),
        name: basename(path.subarray(0, count[0] * 2).toString('utf16le')) }
    }
    inspector = {
      list() {
        const value = snapshot(2, 0)
        if (!value || native.address(value) === 0xffffffffffffffffn) throw new Error('Process enumeration failed.')
        try {
          const row: any = { size: native.sizeof(entry) }, result: Entry[] = []
          let available = first(value, row)
          while (available) {
            result.push({ pid: row.pid, parentPid: row.parentPid,
              name: Buffer.from(new Uint16Array(row.executable).buffer).toString('utf16le').split('\0')[0] })
            if (result.length >= 65536) throw new Error('Process enumeration exceeds its budget.')
            available = next(value, row)
          }
          if (error() !== 18) throw new Error('Process enumeration did not complete.')
          return result
        } finally { close(value) }
      },
      inspect: pid => withProcess(pid, 0, value => identity(value, pid)),
      terminate(info) {
        withProcess(info.pid, 1, value => {
          if (identity(value, info.pid).birth !== info.birth) throw new Error('The process identity has changed. Refresh the list.')
          if (!stop(value, 1)) throw new Error(`Could not terminate process ${info.pid} (Win32 ${error()}).`)
        })
      }
    }
    return inspector
  }
  const library = native.load(null)
  const listPids = process.platform === 'darwin' ? library.func('int proc_listallpids(void *buffer, int buffersize)') : undefined
  const pidInfo = process.platform === 'darwin' ? library.func('int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)') : undefined
  const bsd = pidInfo ? native.struct({ flags: 'uint32', status: 'uint32', xstatus: 'uint32', pid: 'uint32', ppid: 'uint32',
    uid: 'uint32', gid: 'uint32', ruid: 'uint32', rgid: 'uint32', svuid: 'uint32', svgid: 'uint32', reserved: 'uint32',
    comm: native.array('char', 16), name: native.array('char', 32), nfiles: 'uint32', pgid: 'uint32', jobc: 'uint32',
    tdev: 'uint32', tpgid: 'uint32', nice: 'int32', seconds: 'uint64', micros: 'uint64' }) : undefined
  const inspect = (pid: number): Info | undefined => {
    if (pidInfo && bsd) {
      const data = Buffer.alloc(native.sizeof(bsd))
      if (pidInfo(pid, 3, 0, data, data.length) !== data.length) {
        try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined }
        throw new Error(`Cannot inspect process ${pid}.`)
      }
      const row: any = native.decode(data, bsd)
      if (row.pid !== pid || row.status === 5) return undefined
      return { pid, parentPid: row.ppid, birth: `${row.seconds}:${row.micros}`,
        startedAt: new Date(Number(row.seconds) * 1000 + Number(row.micros) / 1000).toISOString(),
        name: Buffer.from(row.name).toString().split('\0')[0] || Buffer.from(row.comm).toString().split('\0')[0] }
    }
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), end = stat.lastIndexOf(')')
      const fields = stat.slice(end + 2).split(/\s+/)
      if (fields[0] === 'Z') return undefined
      return { pid, parentPid: Number(fields[1]), birth: fields[19], startedAt: '', name: stat.slice(stat.indexOf('(') + 1, end) }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  inspector = {
    inspect,
    list() {
      let pids: number[]
      if (listPids) {
        const data = new Int32Array(65536), count = Number(listPids(data, data.byteLength))
        if (count <= 0 || count >= data.length) throw new Error('Process enumeration is unavailable or exceeds its budget.')
        pids = Array.from(data.subarray(0, count))
      } else pids = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number)
      if (pids.length > 65536) throw new Error('Process enumeration exceeds its budget.')
      return pids.filter(pid => pid > 1).flatMap(pid => { try { const info = inspect(pid); return info ? [info] : [] } catch { return [] } })
    },
    terminate(info) {
      const current = inspect(info.pid)
      if (!current) return
      if (current.birth !== info.birth) throw new Error('The process identity has changed. Refresh the list.')
      try { process.kill(info.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  }
  return inspector
}

export function terminateObservedProcess(info: ProcessIdentity): void { nativeInspector().terminate(info) }
export function inspectProcess(pid: number): Info | undefined { return nativeInspector().inspect(pid) }

/** Observe the Shell and its direct children, never an application's descendants.
 * Keep each child's original parent binding after POSIX reparenting. */
export function refreshProcesses(known: readonly ProcessIdentity[], rootPid?: number, extraPids: readonly number[] = []): ProcessSnapshot {
  const snapshot: ProcessSnapshot = { processes: [], complete: false, checkedAt: new Date().toISOString() }
  let root = known.find(info => info.role === 'shell')
  let native: Inspector
  try { native = nativeInspector() } catch (error) {
    return { ...snapshot, processes: known.slice(0, 512).filter(info => info.role === 'shell' || root && info.parentPid === root.pid)
      .map(info => ({ ...info, status: 'unknown' })), error: String(error) }
  }
  if (!root && rootPid) {
    try { const info = native.inspect(rootPid); if (info) root = { ...info, role: 'shell' } }
    catch (error) { snapshot.error = String(error) }
  }
  if (!root) return snapshot
  let entries: Entry[] = []
  try {
    const now = Date.now()
    if (!cachedEntries || now - cachedEntries.time > 100) cachedEntries = { time: now, entries: native.list() }
    entries = cachedEntries.entries
  } catch (error) { snapshot.error ??= String(error) }
  const parents = new Map(entries.map(entry => [entry.pid, entry.parentPid]))
  let rootCurrent: Info | undefined, rootInspected = false
  const keys = new Set<string>()
  const add = (info: ProcessIdentity, status: 'running' | 'exited' | 'unknown') => {
    const key = `${info.pid}:${info.birth}`
    if (keys.has(key)) return
    if (keys.size >= 512) { snapshot.error = 'Process tracking reached its 512 identity limit.'; return }
    keys.add(key); snapshot.processes.push({ ...info, status })
  }
  for (const info of [root, ...known.filter(info => info.role !== 'shell').slice(0, 511)]) {
    if (info.role === 'child' && info.parentPid !== 0 && info.parentPid !== root.pid) continue
    try {
      const current = native.inspect(info.pid), same = current?.birth === info.birth
      if (info.role === 'shell') { rootCurrent = current; rootInspected = true }
      // Older Windows observation snapshots may lack a parent binding. Resolve
      // it from the live process table; Job membership alone is not direct ancestry.
      const parentPid = info.parentPid || (same ? current.parentPid || parents.get(info.pid) || 0 : 0)
      if (info.role === 'child' && parentPid !== root.pid) continue
      add({ ...info, parentPid, ...(same ? { name: current.name } : {}) }, same ? 'running' : 'exited')
    } catch (error) {
      if (info.role === 'shell' || info.parentPid === root.pid) add(info, 'unknown')
      snapshot.error ??= String(error)
    }
  }
  const members = new Set(extraPids)
  const rootAlive = rootCurrent?.birth === root.birth
  for (const entry of entries) {
    if (entry.parentPid !== root.pid || entry.pid === root.pid) continue
    if (keys.size >= 512) { snapshot.error = 'Process tracking reached its 512 identity limit.'; break }
    // A still-owned Windows Job can confirm direct children after rapid Shell
    // exit. Never discover new children through an exited/reused historical PID.
    if (!rootAlive && !(rootInspected && !rootCurrent && rootPid === root.pid && members.has(entry.pid))) continue
    try {
      const info = native.inspect(entry.pid)
      if (!info || info.parentPid && info.parentPid !== root.pid
        || root.startedAt && info.startedAt && info.startedAt < root.startedAt) continue
      add({ ...info, parentPid: root.pid, role: 'child' }, 'running')
    } catch (error) { snapshot.error ??= String(error) }
  }
  return snapshot
}

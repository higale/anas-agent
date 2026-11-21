import type koffi from 'koffi'
import type { EventEmitter } from 'node:events'
import type { PassThrough } from 'node:stream'

/** Serialized into the existing supervisor. Native CreateProcess avoids libuv's
 * implicit kill-on-close Job while retaining a hidden console for PowerShell. */
export function spawnWindowsShell(native: typeof koffi, Events: typeof EventEmitter, Stream: typeof PassThrough,
  executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const kernel = native.load('kernel32.dll')
  const handle = native.pointer('void')
  const security = native.struct({ size: 'uint32', descriptor: handle, inherit: 'int' })
  const startup = native.struct({ size: 'uint32', reserved: handle, desktop: handle, title: handle,
    x: 'uint32', y: 'uint32', width: 'uint32', height: 'uint32', charsX: 'uint32', charsY: 'uint32',
    fill: 'uint32', flags: 'uint32', show: 'uint16', reservedSize: 'uint16', reservedBytes: handle,
    stdin: handle, stdout: handle, stderr: handle })
  const information = native.struct({ process: handle, thread: handle, pid: 'uint32', tid: 'uint32' })
  const bind = (name: string, result: any, params: any[]) => kernel.func('__stdcall', name, result, params)
  const close = bind('CloseHandle', 'int', [handle])
  const lastError = bind('GetLastError', 'uint32', [])
  const pipe = bind('CreatePipe', 'int', [native.out(native.pointer(handle)), native.out(native.pointer(handle)), native.pointer(security), 'uint32'])
  const inherit = bind('SetHandleInformation', 'int', [handle, 'uint32', 'uint32'])
  const create = bind('CreateProcessW', 'int', ['str16', handle, handle, handle, 'int', 'uint32', handle, 'str16', native.pointer(startup), native.out(native.pointer(information))])
  const peek = bind('PeekNamedPipe', 'int', [handle, handle, 'uint32', handle, native.out(native.pointer('uint32')), handle])
  const read = bind('ReadFile', 'int', [handle, handle, 'uint32', native.out(native.pointer('uint32')), handle])
  const wait = bind('WaitForSingleObject', 'uint32', [handle, 'uint32'])
  const exitCode = bind('GetExitCodeProcess', 'int', [handle, native.out(native.pointer('uint32'))])
  const terminate = bind('TerminateProcess', 'int', [handle, 'uint32'])
  const handles = new Set<any>()
  const release = (value: any) => { if (handles.delete(value)) close(value) }
  const fail = (name: string): never => { throw new Error(`${name} failed (Win32 ${lastError()}).`) }
  const createPipe = () => {
    const input: any[] = [null], output: any[] = [null]
    if (!pipe(input, output, { size: native.sizeof(security), descriptor: null, inherit: 1 }, 65536)) fail('CreatePipe')
    handles.add(input[0]); handles.add(output[0])
    return { read: input[0], write: output[0] }
  }
  // Windows CRT quoting, including trailing backslashes before the closing quote.
  const quote = (value: string) => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
  const command = [executable, ...args].map(quote).join(' ')
  if (command.length >= 32767) throw new Error('Windows command line exceeds 32766 characters.')
  const child = new Events() as EventEmitter & { pid: number; exitCode: number | null; signalCode: null;
    stdout: PassThrough; stderr: PassThrough; kill(signal?: string): boolean; unref(): void }
  child.stdout = new Stream(); child.stderr = new Stream()
  child.exitCode = null; child.signalCode = null
  let processHandle: any, timer: ReturnType<typeof setInterval> | undefined
  try {
    const stdout = createPipe(), stderr = createPipe(), stdin = createPipe()
    for (const value of [stdout.read, stderr.read, stdin.write]) if (!inherit(value, 1, 0)) fail('SetHandleInformation')
    const info: any = {}
    const environment = Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase())).map(([key, value]) => `${key}=${value}`).join('\0') + '\0\0'
    if (!create(null, Buffer.from(command + '\0', 'utf16le'), null, null, 1, 0x410,
      Buffer.from(environment, 'utf16le'), options.cwd,
      { size: native.sizeof(startup), flags: 0x101, show: 0, stdin: stdin.read, stdout: stdout.write, stderr: stderr.write }, info)) fail('CreateProcessW')
    processHandle = info.process; handles.add(processHandle); handles.add(info.thread)
    child.pid = info.pid
    release(info.thread); release(stdin.read); release(stdin.write); release(stdout.write); release(stderr.write)
    let ended = false
    const pump = (source: any, stream: PassThrough, final = false) => {
      for (let budget = 262144; budget > 0 && (final || stream.readableLength < 65536);) {
        const available = [0]
        if (!peek(source, null, 0, null, available, null) || !available[0]) break
        const buffer = Buffer.alloc(Math.min(available[0], 16384, budget)), count = [0]
        if (!read(source, buffer, buffer.length, count, null) || !count[0]) break
        stream.write(buffer.subarray(0, count[0])); budget -= count[0]
      }
    }
    const poll = () => {
      if (ended) return
      const finished = wait(processHandle, 0) === 0
      pump(stdout.read, child.stdout, finished); pump(stderr.read, child.stderr, finished)
      if (!finished) return
      ended = true
      const code = [0]
      if (!exitCode(processHandle, code)) { child.emit('error', new Error('Could not read the Shell exit code.')); code[0] = 1 }
      child.exitCode = code[0]
      if (timer) clearInterval(timer)
      for (const value of [...handles]) release(value)
      child.emit('exit', code[0], null)
      child.stdout.end(); child.stderr.end()
      child.emit('close', code[0], null)
    }
    child.kill = () => ended || wait(processHandle, 0) === 0 || Boolean(terminate(processHandle, 1))
    child.unref = () => timer?.unref()
    timer = setInterval(poll, 20)
    queueMicrotask(() => { child.emit('spawn'); poll() })
    return child
  } catch (error) {
    if (processHandle) terminate(processHandle, 1)
    if (timer) clearInterval(timer)
    for (const value of [...handles]) release(value)
    child.stdout.destroy(); child.stderr.destroy()
    throw error
  }
}

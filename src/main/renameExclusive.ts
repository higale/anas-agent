import { createRequire } from 'node:module'
import { toNamespacedPath } from 'node:path'
import { getSystemErrorName } from 'node:util'

type Rename = (from: string, to: string) => void
let nativeRename: Rename | undefined

function bindRename(): Rename {
  const native = createRequire(import.meta.url)('koffi') as typeof import('koffi').default
  if (process.platform === 'win32') {
    const kernel = native.load('kernel32.dll')
    const move = kernel.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint32'])
    const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32', [])
    return (from, to) => {
      if (move(toNamespacedPath(from), toNamespacedPath(to), 0)) return
      const error = lastError()
      const code = error === 80 || error === 183 ? 'EEXIST' : undefined
      throw Object.assign(new Error(`MoveFileExW failed (Win32 ${error}): ${to}`), { code })
    }
  }
  const libc = native.load(null)
  let move: (from: string, to: string) => number
  if (process.platform === 'darwin') {
    const rename = libc.func('int renamex_np(const char *from, const char *to, unsigned int flags)')
    move = (from, to) => rename(from, to, 0x4) // RENAME_EXCL
  } else if (process.platform === 'linux') {
    const rename = libc.func('int renameat2(int oldfd, const char *from, int newfd, const char *to, unsigned int flags)')
    move = (from, to) => rename(-100, from, -100, to, 1) // AT_FDCWD, RENAME_NOREPLACE
  } else {
    throw new Error(`Exclusive rename is unsupported on ${process.platform}.`)
  }
  return (from, to) => {
    if (move(from, to) === 0) return
    const errno = native.errno()
    const code = getSystemErrorName(-errno)
    throw Object.assign(new Error(`Exclusive rename failed (${code}): ${to}`), { code })
  }
}

/** Commit a staged file or directory only if the target name is still free. */
export function renameExclusive(from: string, to: string): void {
  nativeRename ??= bindRename()
  nativeRename(from, to)
}

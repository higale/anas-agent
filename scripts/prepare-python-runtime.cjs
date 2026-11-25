const { createHash } = require('node:crypto')
const { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const manifest = require('../build/python-runtime.json')
const root = resolve(__dirname, '..')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { windowsHide: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr}`)
  return result.stdout
}

function removeChild(parent, target) {
  if (dirname(target) !== parent || lstatSync(target).isSymbolicLink()) throw new Error(`Unexpected runtime staging path: ${target}`)
  rmSync(target, { recursive: true, force: true })
}

function validArchive(file, spec) {
  return existsSync(file) && statSync(file).size === spec.bytes
    && createHash('sha256').update(readFileSync(file)).digest('hex') === spec.sha256
}

// The build host owns dependency installation. Ship a runtime, not a package manager.
function trimRuntime(pythonRoot, platform) {
  const stdlib = join(pythonRoot, platform === 'win32' ? 'Lib' : `lib/python${manifest.version.split('.').slice(0, 2).join('.')}`)
  const sitePackages = join(stdlib, 'site-packages')
  for (const [directory, matches] of [
    [stdlib, name => name === 'ensurepip'],
    [sitePackages, name => /^(?:pip|setuptools|wheel)(?:$|[-.])|^_distutils_hack$|^distutils-precedence\.pth$/.test(name)],
    [join(pythonRoot, platform === 'win32' ? 'Scripts' : 'bin'), name => /^(?:pip(?:\d+(?:\.\d+)?)?|easy_install(?:-\d+(?:\.\d+)?)?|wheel)(?:\.exe|-script\.py)?$/.test(name)]
  ]) {
    if (!existsSync(directory)) continue
    for (const name of readdirSync(directory)) {
      if (!matches(name)) continue
      const target = join(directory, name)
      // Remove a launcher symlink itself, never the interpreter it points to.
      if (lstatSync(target).isSymbolicLink()) unlinkSync(target)
      else removeChild(directory, target)
    }
  }
  writeFileSync(join(stdlib, 'EXTERNALLY-MANAGED'), '[externally-managed]\nError = This Python runtime is managed by Anas. Use a separate user-managed Python environment to install dependencies.\n')
}

function preparePythonRuntime(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`
  const spec = manifest.targets[target]
  if (!spec) {
    if (platform === 'win32' || platform === 'darwin') throw new Error(`No pinned Python runtime for ${target}`)
    return
  }
  const cache = join(root, 'tmp', 'python-downloads')
  mkdirSync(cache, { recursive: true })
  const archive = join(cache, `${spec.sha256}.tar.gz`)
  if (!validArchive(archive, spec)) {
    const partial = `${archive}.partial`
    // curl uses the build host's proxy configuration; no download occurs in the app.
    run(platform === 'win32' && process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--fail', '--location', '--silent', '--show-error', '--retry', '2', '--connect-timeout', '20', '--max-time', '300',
      '--output', partial, spec.url
    ], { timeout: 960_000 })
    if (!validArchive(partial, spec)) throw new Error(`Python archive checksum/size mismatch: ${target}`)
    renameSync(partial, archive)
  }
  const entries = run('tar', ['-tzf', archive]).trim().split(/\r?\n/)
  if (entries.some(name => !name.startsWith('python/') || name.split('/').includes('..') || name.includes('\\'))) {
    throw new Error('Unexpected Python archive layout')
  }
  const destinationRoot = join(root, 'build', 'python-runtime')
  mkdirSync(destinationRoot, { recursive: true })
  const stage = mkdtempSync(join(cache, `${target}-staging-`))
  try {
    run('tar', ['-xzf', archive, '-C', stage])
    const python = join(stage, 'python', platform === 'win32' ? 'python.exe' : 'bin/python3')
    if (!existsSync(python)) throw new Error(`Python executable is missing: ${python}`)
    trimRuntime(join(stage, 'python'), platform)
    const nativeTarget = platform === process.platform && arch === process.arch
    const buildPython = nativeTarget ? python : process.platform === 'win32' ? 'python' : 'python3'
    run(buildPython, [
      '-I', '-B', join(__dirname, 'prepare-document-wheels.py'), target, join(stage, 'python', 'anas-documents')
    ], { timeout: 600_000 })
    if (nativeTarget) {
      const version = run(python, ['-I', '-B', '-c', 'import sys,ssl,sqlite3,ctypes,importlib.util; assert all(importlib.util.find_spec(name) is None for name in ("pip","ensurepip","setuptools","wheel")); print(".".join(map(str,sys.version_info[:3])))']).trim()
      if (version !== manifest.version) throw new Error(`Unexpected Python version: ${version}`)
    }
    writeFileSync(join(stage, 'python', 'anas-runtime.json'), `${JSON.stringify({ ...spec, version: manifest.version, target }, null, 2)}\n`)
    const destination = join(destinationRoot, target)
    if (existsSync(destination)) removeChild(destinationRoot, destination)
    renameSync(stage, destination)
    console.log(`Prepared Python ${manifest.version} (${target}, ${(spec.bytes / 1048576).toFixed(1)} MiB download).`)
  } finally {
    if (existsSync(stage)) removeChild(cache, stage)
  }
}

module.exports = { preparePythonRuntime }
if (require.main === module) preparePythonRuntime(process.argv[2] || process.platform, process.argv[3] || process.arch)

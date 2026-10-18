const { createWriteStream } = require('node:fs')
const { cp, lstat, mkdir, mkdtemp, readdir, rename, rm, stat } = require('node:fs/promises')
const { dirname, join, resolve, sep } = require('node:path')
const { pipeline } = require('node:stream/promises')
const { ZipFile } = require('yazl')

const included = name => name !== '__pycache__' && name !== '.DS_Store' && !/\.py[co]$/.test(name)
const zipTime = new Date('2000-01-01T00:00:00Z')

async function zipPlugin(source, target) {
  if (!(await lstat(join(source, 'PLUGIN.json'))).isFile()) throw new Error(`Missing plugin manifest: ${source}`)
  const files = []
  async function add(directory, prefix = '') {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      if (!included(entry.name)) continue
      const path = join(directory, entry.name), relative = prefix + entry.name
      if (entry.isDirectory()) {
        files.push({ directory: true, relative })
        await add(path, relative + '/')
      } else if (entry.isFile()) {
        const executable = (await stat(path)).mode & 0o111
        files.push({ path, relative, mode: executable ? 0o100755 : 0o100644 })
      } else throw new Error(`Plugin example must contain ordinary files: ${path}`)
    }
  }
  await add(source)
  const zip = new ZipFile()
  zip.on('error', error => zip.outputStream.destroy(error))
  const writing = pipeline(zip.outputStream, createWriteStream(target))
  for (const file of files) {
    if (file.directory) zip.addEmptyDirectory(file.relative, { mtime: zipTime, mode: 0o40755 })
    else zip.addFile(file.path, file.relative, { mtime: zipTime, mode: file.mode })
  }
  zip.end()
  await writing
}

/** Source stays editable; only generated ZIPs and documentation are distributed. */
async function prepareExamples(source, target) {
  source = resolve(source); target = resolve(target)
  if (source === target || source.startsWith(target + sep) || target.startsWith(source + sep)) {
    throw new Error('Example source and output directories must be separate.')
  }
  const previous = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) throw new Error('Example output must be a regular directory.')
  await mkdir(dirname(target), { recursive: true })
  const stage = await mkdtemp(join(dirname(target), '.examples-build-'))
  try {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (!included(entry.name)) continue
      if (entry.name === 'plugins') continue
      await cp(join(source, entry.name), join(stage, entry.name), { recursive: true, filter: path => included(path.split(/[\\/]/).at(-1)) })
    }
    const plugins = join(stage, 'plugins')
    await mkdir(plugins)
    let count = 0
    for (const entry of await readdir(join(source, 'plugins'), { withFileTypes: true })) {
      if (!included(entry.name)) continue
      const path = join(source, 'plugins', entry.name)
      if (entry.isDirectory()) {
        await zipPlugin(path, join(plugins, entry.name + '.zip'))
        count++
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) await cp(path, join(plugins, entry.name))
      else throw new Error(`Unexpected plugin example resource: ${path}`)
    }
    if (!count) throw new Error('No plugin examples were built.')
    await rm(target, { recursive: true, force: true })
    await rename(stage, target)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

module.exports = { prepareExamples }
if (require.main === module) {
  const root = resolve(__dirname, '..')
  prepareExamples(join(root, 'data/examples'), join(root, 'out/examples'))
    .then(() => console.log('Prepared examples with plugin ZIP packages.'))
    .catch(error => { console.error(error); process.exitCode = 1 })
}

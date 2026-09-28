import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ display: vi.fn(), dock: vi.fn(), mac: vi.fn(), bitmap: vi.fn() }))
vi.mock('electron', () => ({ nativeImage: {
  createFromPath: () => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 3 }),
    toBitmap: () => Buffer.from(Array.from({ length: 24 }, (_, index) => Math.floor(index / 4))) }),
  createFromBitmap: mocks.bitmap
} }))
vi.mock('./avatarIconGenerator', () => ({
  assertAvatarImageReadable: (path: string) => {
    if (!readFileSync(path, 'utf8').startsWith('good')) throw new Error('Image cannot be decoded')
  },
  createAvatarWindowsIco: () => Buffer.from('good ico'),
  writeAvatarDisplayPng: mocks.display,
  writeAvatarDockPng: mocks.dock,
  writeAvatarMacIcns: mocks.mac
}))
import { inspectAvatarRepair, repairAvatarData } from './recoveryAvatar'
import { avatarWindowsIconPathForCrop, initializeAvatarAssets, readAvatarTransform } from './avatarAssets'

const roots: string[] = []
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const transform = { crop: { x: 0, y: 0, width: 100, height: 100 }, rotation: 90 }
beforeEach(() => {
  for (const mock of [mocks.display, mocks.dock, mocks.mac]) mock.mockReset().mockImplementation(async (_source: string, target: string) => writeFile(target, 'good generated'))
  mocks.bitmap.mockReset().mockReturnValue({ toPNG: () => Buffer.from('good rebuilt crop') })
})
afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anas-avatar-rescue-'))
  roots.push(root)
  const data = join(root, 'data'), assets = join(data, 'assets'), backup = join(root, 'preserved')
  await mkdir(assets, { recursive: true })
  for (const [name, content] of Object.entries({
    'avatar-source.png': 'good original source', 'avatar-crop.png': 'good original crop',
    'avatar.png': 'good display', 'avatar-dock.png': 'good dock', 'avatar.icns': 'good icns',
    'unrelated.bin': 'retain unrelated bytes', 'avatar-transform.json': JSON.stringify({ version: 0, ...transform })
  })) await writeFile(join(assets, name), content)
  const preserve = vi.fn(async () => { await cp(assets, backup, { recursive: true, dereference: false }); return backup })
  return { root, data, assets, backup, preserve }
}

describe('manual avatar rescue', () => {
  it('checks read-only and fixes only metadata when all images are usable', async () => {
    const { data, assets, backup, preserve } = await fixture()
    const original = JSON.stringify({ version: 99, ...transform, annotation: 'keep' })
    await writeFile(join(assets, 'avatar-transform.json'), original)
    expect(await inspectAvatarRepair(data)).toEqual({ fields: ['assets/avatar-transform.json: version'], issues: [] })
    expect(await readFile(join(assets, 'avatar-transform.json'), 'utf8')).toBe(original)
    const result = await repairAvatarData(data, preserve)
    expect(result.unresolved).toEqual([])
    expect(result.preservationPath).toBe(backup)
    expect(await readFile(join(backup, 'avatar-transform.json'), 'utf8')).toBe(original)
    for (const name of ['avatar-source.png', 'avatar-crop.png', 'avatar.png', 'avatar-dock.png', 'avatar.icns', 'unrelated.bin']) {
      expect(await readFile(join(assets, name))).toEqual(await readFile(join(backup, name)))
    }
    expect(await readAvatarTransform(data)).toEqual(transform)
    expect(JSON.parse(await readFile(join(assets, 'avatar-transform.json'), 'utf8')).annotation).toBe('keep')
    expect(mocks.display).not.toHaveBeenCalled()
    expect(await repairAvatarData(data, preserve)).toEqual({ repaired: [], unresolved: [] })
    expect(preserve).toHaveBeenCalledOnce()
  })

  it('rescues a damaged source from the usable crop and regenerates missing output', async () => {
    const { data, assets, backup, preserve } = await fixture()
    await writeFile(join(assets, 'avatar-source.png'), 'broken source')
    await rm(join(assets, 'avatar.png'))
    await expect(initializeAvatarAssets(data)).rejects.toThrow('Image cannot be decoded')
    expect((await inspectAvatarRepair(data)).fields.length).toBeGreaterThan(0)
    const result = await repairAvatarData(data, preserve)
    expect(result.unresolved).toEqual([])
    expect(await readFile(join(assets, 'avatar-source.png'), 'utf8')).toBe('good original crop')
    expect(await readFile(join(assets, 'avatar-crop.png'), 'utf8')).toBe('good original crop')
    expect(await readFile(join(backup, 'avatar-source.png'), 'utf8')).toBe('broken source')
    expect(await readFile(join(assets, 'unrelated.bin'), 'utf8')).toBe('retain unrelated bytes')
    expect(await readAvatarTransform(data)).toEqual({ crop: { x: 0, y: 0, width: 100, height: 100 }, rotation: 0 })
    expect(await inspectAvatarRepair(data)).toEqual({ fields: [], issues: [] })
    await expect(initializeAvatarAssets(data)).resolves.toBeDefined()
  })

  it.each([
    { rotation: 0, width: 2, height: 3, pixels: [0, 1, 2, 3, 4, 5] },
    { rotation: 90, width: 3, height: 2, pixels: [4, 2, 0, 5, 3, 1] },
    { rotation: 180, width: 2, height: 3, pixels: [5, 4, 3, 2, 1, 0] },
    { rotation: 270, width: 3, height: 2, pixels: [1, 3, 5, 0, 2, 4] }
  ])('reconstructs a missing crop at $rotation degrees without replacing the source', async ({ rotation, width, height, pixels }) => {
    const { data, assets, preserve } = await fixture()
    const selected = { ...transform, rotation }
    await writeFile(join(assets, 'avatar-transform.json'), JSON.stringify({ version: 0, ...selected }))
    await rm(join(assets, 'avatar-crop.png'))
    expect((await repairAvatarData(data, preserve)).unresolved).toEqual([])
    expect(await readFile(join(assets, 'avatar-source.png'), 'utf8')).toBe('good original source')
    expect(await readAvatarTransform(data)).toEqual(selected)
    const [bitmap, size] = mocks.bitmap.mock.calls[0]
    expect(size).toEqual({ width, height })
    expect(Array.from(bitmap as Buffer).filter((_, index) => index % 4 === 0)).toEqual(pixels)
  })

  it('applies percentage crop coordinates against the rotated source', async () => {
    const { data, assets, preserve } = await fixture()
    await writeFile(join(assets, 'avatar-transform.json'), JSON.stringify({ version: 0,
      rotation: 90, crop: { x: 100 / 3, y: 50, width: 100 / 3, height: 50 }
    }))
    await rm(join(assets, 'avatar-crop.png'))
    expect((await repairAvatarData(data, preserve)).unresolved).toEqual([])
    const [bitmap, size] = mocks.bitmap.mock.calls[0]
    expect(size).toEqual({ width: 1, height: 1 })
    expect(Array.from(bitmap as Buffer)).toEqual([3, 3, 3, 3])
  })

  it('recovers missing transform from the retained visible crop', async () => {
    const { data, assets, backup, preserve } = await fixture()
    await rm(join(assets, 'avatar-transform.json'))
    expect((await repairAvatarData(data, preserve)).unresolved).toEqual([])
    expect(await readFile(join(assets, 'avatar-source.png'), 'utf8')).toBe('good original crop')
    expect(await readFile(join(backup, 'avatar-source.png'), 'utf8')).toBe('good original source')
    expect(await inspectAvatarRepair(data)).toEqual({ fields: [], issues: [] })
  })

  it('preserves all unreadable originals and reports failure without installing a default avatar', async () => {
    const { data, assets, backup, preserve } = await fixture()
    for (const name of ['avatar-source.png', 'avatar-crop.png', 'avatar.png']) await writeFile(join(assets, name), 'broken image')
    const result = await repairAvatarData(data, preserve)
    expect(result.repaired).toEqual([])
    expect(result.unresolved.join('\n')).toContain('no image can be recovered')
    for (const name of await readdir(assets)) expect(await readFile(join(assets, name))).toEqual(await readFile(join(backup, name)))
  })

  it('keeps the original asset set when generation fails after preservation', async () => {
    const { data, assets, backup, preserve } = await fixture()
    await rm(join(assets, 'avatar.png'))
    mocks.display.mockRejectedValue(new Error('generation failed'))
    const result = await repairAvatarData(data, preserve)
    expect(result.repaired).toEqual([])
    expect(result.unresolved.join('\n')).toContain('generation failed')
    expect(await readdir(data)).toEqual(['assets'])
    for (const name of await readdir(assets)) expect(await readFile(join(assets, name))).toEqual(await readFile(join(backup, name)))
  })

  it('does not overwrite concurrent changes or modify data when preservation fails', async () => {
    const { data, assets, preserve } = await fixture()
    await rm(join(assets, 'avatar.png'))
    await expect(repairAvatarData(data, async () => { throw new Error('no backup space') })).rejects.toThrow('no backup space')
    expect(mocks.display).not.toHaveBeenCalled()
    const result = await repairAvatarData(data, async () => {
      const backup = await preserve()
      await writeFile(join(assets, 'avatar-source.png'), 'good new source from user')
      return backup
    })
    expect(result.unresolved.join('\n')).toContain('changed during repair')
    expect(await readFile(join(assets, 'avatar-source.png'), 'utf8')).toBe('good new source from user')
  })

  it('replaces damaged output links without writing through them', async () => {
    const { root, data, assets, preserve } = await fixture()
    const target = join(root, 'outside.png')
    await writeFile(target, 'external original')
    await rm(join(assets, 'avatar.png'))
    await symlink(target, join(assets, 'avatar.png'))
    expect((await repairAvatarData(data, preserve)).unresolved).toEqual([])
    expect(await readFile(target, 'utf8')).toBe('external original')
    expect(await readFile(join(assets, 'avatar.png'), 'utf8')).toBe('good generated')
  })

  it('does not follow a dangling Windows icon link when regenerating it', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const { root, data, assets, preserve } = await fixture()
    const target = join(root, 'outside.ico')
    const icon = await avatarWindowsIconPathForCrop(join(assets, 'avatar-crop.png'), data)
    await symlink(target, icon)
    expect((await repairAvatarData(data, preserve)).unresolved).toEqual([])
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(icon, 'utf8')).toBe('good ico')
  })
})

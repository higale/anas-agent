import { cp, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { nativeImage } from 'electron'
import { defaultAvatarTransform, requireAvatarTransform } from '@shared/avatar'
import { errorDetail, type RecoveryRepairResult } from '@shared/recovery'
import type { AvatarTransform } from '@shared/types'
import {
  avatarAssetDir, avatarCropImagePath, avatarDisplayImagePath, avatarDockIconPath,
  avatarImageExtensions, avatarMacIconPath, avatarTransformPath, findAvatarWindowsIconPath,
  avatarWindowsIconPathForCrop, withAvatarAssetTransaction, writeDerivedAvatarAssets
} from './avatarAssets'
import { assertAvatarImageReadable } from './avatarIconGenerator'

interface AvatarPlan {
  fields: string[]
  issues: string[]
  source?: string
  crop?: string
  sources: string[]
  replaceSource: boolean
  rebuildCrop: boolean
  regenerate: boolean
  document?: Record<string, unknown>
  transform: AvatarTransform
  fingerprint: string
}

async function fingerprint(root: string): Promise<string> {
  try {
    const directory = await lstat(avatarAssetDir(root))
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Avatar assets must be a regular directory.')
    const entries = await Promise.all((await readdir(avatarAssetDir(root))).sort().map(async name => {
      const info = await lstat(join(avatarAssetDir(root), name))
      return [name, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]
    }))
    return JSON.stringify([directory.dev, directory.ino, entries])
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function regularFile(path: string): Promise<boolean> {
  try { const info = await lstat(path); return info.isFile() && info.size > 0 } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readableImage(path: string): Promise<boolean> {
  if (!(await regularFile(path))) return false
  try { assertAvatarImageReadable(path); return true } catch { return false }
}

async function planAvatarRepair(root: string): Promise<AvatarPlan> {
  const plan: AvatarPlan = { fields: [], issues: [], sources: [], replaceSource: false, rebuildCrop: false,
    regenerate: false, transform: defaultAvatarTransform, fingerprint: await fingerprint(root) }
  if (!plan.fingerprint) return plan
  const names = await readdir(avatarAssetDir(root))
  plan.sources = avatarImageExtensions.map(extension => join(avatarAssetDir(root), `avatar-source${extension}`))
    .filter(path => names.includes(basename(path)))
  if (!plan.sources.length && !names.some(name => name.startsWith('avatar'))) return plan
  const add = (field: string) => plan.fields.push(`assets/${field}`)
  let transformValid = false
  try {
    if (!(await regularFile(avatarTransformPath(root)))) throw new Error('Avatar transform is missing or not a regular file.')
    const raw: unknown = JSON.parse(await readFile(avatarTransformPath(root), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid avatar transform.')
    plan.document = { ...raw }
    plan.transform = requireAvatarTransform(raw)
    transformValid = true
    if (plan.document.version !== 0) {
      plan.document.version = 0
      add('avatar-transform.json: version')
    }
  } catch {
    add('avatar-transform.json: recover transform from retained image')
  }
  for (const path of plan.sources) {
    if (await readableImage(path)) { plan.source = path; break }
  }
  if (await readableImage(avatarCropImagePath(root))) plan.crop = avatarCropImagePath(root)
  // A display PNG is a last surviving copy of the custom avatar, not a default.
  if (!plan.source && !plan.crop && await readableImage(avatarDisplayImagePath(root))) plan.crop = avatarDisplayImagePath(root)
  if (!plan.source && !plan.crop) {
    plan.issues.push('Avatar source, crop, and display images are unreadable or missing; no image can be recovered. Original assets will be preserved.')
    return plan
  }
  if (!plan.source || plan.source !== plan.sources[0] || !transformValid && plan.crop) {
    plan.source = plan.crop ?? plan.source
    plan.replaceSource = true
    plan.transform = defaultAvatarTransform
    plan.document = { version: 0, ...plan.transform }
    add('avatar-source: recover from readable image')
    if (!plan.fields.some(field => field.includes('avatar-transform'))) add('avatar-transform.json: match recovered source')
  } else if (!transformValid) {
    plan.transform = defaultAvatarTransform
    plan.document = { version: 0, ...plan.transform }
  }
  if (!plan.crop || plan.crop !== avatarCropImagePath(root)) {
    plan.rebuildCrop = true
    add('avatar-crop.png: recover crop')
  }
  const derived = [avatarDisplayImagePath(root), avatarDockIconPath(root)]
  for (const path of derived) {
    if (!(await readableImage(path))) { plan.regenerate = true; add(`${basename(path)}: regenerate`) }
  }
  if (process.platform === 'darwin' && !(await regularFile(avatarMacIconPath(root)))) {
    plan.regenerate = true
    add('avatar.icns: regenerate')
  }
  if (process.platform === 'win32') {
    const path = await findAvatarWindowsIconPath(root)
    if (!path || !(await regularFile(path))) { plan.regenerate = true; add('avatar.ico: regenerate') }
  }
  plan.regenerate ||= plan.rebuildCrop
  return plan
}

export async function inspectAvatarRepair(root: string): Promise<{ fields: string[]; issues: string[] }> {
  try { const { fields, issues } = await planAvatarRepair(root); return { fields, issues } } catch (error) {
    return { fields: [], issues: [errorDetail(error)] }
  }
}

// The UI records crop percentages against the rotated source. Reconstruct those
// pixels directly so a missing crop does not discard a valid user transform.
function cropPng(path: string, transform: AvatarTransform): Buffer {
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) throw new Error('Avatar source image could not be decoded.')
  const { width, height } = image.getSize()
  const quarterTurn = transform.rotation === 90 || transform.rotation === 270
  const rotatedWidth = quarterTurn ? height : width, rotatedHeight = quarterTurn ? width : height
  const crop = transform.crop
  const x = Math.min(rotatedWidth - 1, Math.round(rotatedWidth * crop.x / 100))
  const y = Math.min(rotatedHeight - 1, Math.round(rotatedHeight * crop.y / 100))
  const cropWidth = Math.max(1, Math.min(rotatedWidth - x, Math.round(rotatedWidth * crop.width / 100)))
  const cropHeight = Math.max(1, Math.min(rotatedHeight - y, Math.round(rotatedHeight * crop.height / 100)))
  const source = image.toBitmap(), output = Buffer.alloc(cropWidth * cropHeight * 4)
  for (let row = 0; row < cropHeight; row++) for (let column = 0; column < cropWidth; column++) {
    const rx = x + column, ry = y + row
    const sx = transform.rotation === 90 ? ry : transform.rotation === 180 ? width - 1 - rx : transform.rotation === 270 ? width - 1 - ry : rx
    const sy = transform.rotation === 90 ? height - 1 - rx : transform.rotation === 180 ? height - 1 - ry : transform.rotation === 270 ? rx : ry
    source.copy(output, (row * cropWidth + column) * 4, (sy * width + sx) * 4, (sy * width + sx + 1) * 4)
  }
  return nativeImage.createFromBitmap(output, { width: cropWidth, height: cropHeight }).toPNG()
}

export async function repairAvatarData(root: string, preserve: () => Promise<string>): Promise<RecoveryRepairResult> {
  const result: RecoveryRepairResult = { repaired: [], unresolved: [] }
  let plan: AvatarPlan
  try { plan = await planAvatarRepair(root) } catch (error) {
    result.preservationPath = await preserve()
    result.unresolved = [errorDetail(error)]
    return result
  }
  if (!plan.fields.length && !plan.issues.length) return result
  result.preservationPath = await preserve()
  if (plan.issues.length) { result.unresolved = plan.issues; return result }
  try {
    const verify = async () => {
      if (await fingerprint(root) !== plan.fingerprint) throw new Error('Avatar assets changed during repair; inspect again before retrying.')
    }
    await verify()
    await withAvatarAssetTransaction(root, async staged => {
      await cp(avatarAssetDir(root), avatarAssetDir(staged), { recursive: true, dereference: false, verbatimSymlinks: true })
      let source = join(avatarAssetDir(staged), basename(plan.source!))
      if (plan.replaceSource) {
        const bytes = await readFile(plan.source!)
        for (const path of plan.sources) await rm(join(avatarAssetDir(staged), basename(path)), { force: true })
        source = join(avatarAssetDir(staged), `avatar-source${extname(plan.source!)}`)
        await writeFile(source, bytes)
      }
      if (plan.fields.some(field => field.includes('avatar-transform'))) {
        await rm(avatarTransformPath(staged), { force: true })
        await writeFile(avatarTransformPath(staged), `${JSON.stringify(plan.document, null, 2)}\n`)
      }
      if (plan.rebuildCrop) {
        await rm(avatarCropImagePath(staged), { force: true })
        await writeFile(avatarCropImagePath(staged), plan.crop ? await readFile(plan.crop) : cropPng(source, plan.transform))
      }
      if (plan.regenerate) {
        const windows = await avatarWindowsIconPathForCrop(avatarCropImagePath(staged), staged)
        for (const path of [avatarDisplayImagePath(staged), avatarDockIconPath(staged), avatarMacIconPath(staged), windows]) {
          await rm(path, { force: true })
        }
        await writeDerivedAvatarAssets(source, avatarCropImagePath(staged), avatarTransformPath(staged), staged)
      }
      const validation = await inspectAvatarRepair(staged)
      if (validation.fields.length || validation.issues.length) throw new Error([...validation.issues, ...validation.fields].join('\n'))
      await verify()
    })
    result.repaired = plan.fields
  } catch (error) { result.unresolved = [errorDetail(error)] }
  return result
}

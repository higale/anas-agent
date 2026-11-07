const assert = require('node:assert/strict')
const { mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, dirname, join } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')

async function visibleCrop(page) {
  return page.locator('.avatar-crop-preview').evaluate(preview => {
    const image = preview.querySelector('img').getBoundingClientRect()
    const area = preview.querySelector('.reactEasyCrop_CropArea').getBoundingClientRect()
    return { x: (area.left - image.left) / image.width * 100,
      y: (area.top - image.top) / image.height * 100,
      width: area.width / image.width * 100, height: area.height / image.height * 100 }
  })
}

function cropDifference(actual, expected) {
  return Math.max(...['x', 'y', 'width', 'height'].map(key => Math.abs(actual[key] - expected[key])))
}

async function verifyAvatarCrop(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-avatar-crop-'))
  assert.equal(dirname(root), tmpdir())
  assert.ok(basename(root).startsWith('anas-avatar-crop-'))
  let application
  try {
    application = await launchApplication(root)
    const page = await application.firstWindow()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(String(error)))
    await page.locator('[data-agent-composer-input]').waitFor()
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en' }))
    await page.locator('.sidebar-profile-header .ui-avatar').click()
    const dialog = page.locator('.avatar-crop-dialog')
    const save = dialog.getByRole('button', { name: 'Save', exact: true })
    const open = async () => {
      await page.getByRole('button', { name: 'Edit avatar', exact: true }).click()
      await expect(save).toBeEnabled()
    }
    const saveAndRead = async () => {
      await save.click()
      await expect(dialog).toHaveCount(0)
      return page.evaluate(async () => (await globalThis.gale.files.getAvatarSource()).transform)
    }
    const fixtures = [
      { width: 1200, height: 800, rotation: 0, zoom: 2.5 },
      { width: 1200, height: 800, rotation: 90, zoom: 2.5 },
      { width: 1200, height: 800, rotation: 180, zoom: 5 },
      { width: 1200, height: 800, rotation: 270, zoom: 1 },
      { width: 800, height: 1200, rotation: 0, zoom: 2.5 },
      { width: 800, height: 1200, rotation: 90, zoom: 2.5 },
      { width: 800, height: 800, rotation: 0, zoom: 2.5 },
      { width: 80, height: 120, rotation: 270, zoom: 2.5 }
    ]
    for (const [index, fixture] of fixtures.entries()) {
      const images = await page.evaluate(({ width, height, rotation, zoom }) => {
        const source = globalThis.document.createElement('canvas')
        source.width = width; source.height = height
        const context = source.getContext('2d')
        const cell = Math.min(width, height) / 8
        for (let y = 0; y < height; y += cell) for (let x = 0; x < width; x += cell) {
          context.fillStyle = `hsl(${x / width * 300}, 75%, ${30 + y / height * 40}%)`
          context.fillRect(x, y, cell, cell)
          context.fillStyle = 'white'; context.font = `${cell / 4}px sans-serif`
          context.fillText(`${Math.round(x)},${Math.round(y)}`, x + 3, y + cell / 2)
        }
        const rotated = globalThis.document.createElement('canvas')
        rotated.width = rotation % 180 === 0 ? width : height
        rotated.height = rotation % 180 === 0 ? height : width
        const rotatedContext = rotated.getContext('2d')
        rotatedContext.translate(rotated.width / 2, rotated.height / 2)
        rotatedContext.rotate(rotation * Math.PI / 180)
        rotatedContext.drawImage(source, -width / 2, -height / 2)
        const side = Math.min(width, height) / zoom
        const x = Math.min(rotated.width - side, rotated.width * 0.85 - side / 2)
        const y = Math.max(0, rotated.height * 0.2 - side / 2)
        const crop = globalThis.document.createElement('canvas')
        crop.width = Math.round(side); crop.height = Math.round(side)
        crop.getContext('2d').drawImage(rotated, x, y, side, side, 0, 0, crop.width, crop.height)
        return { source: source.toDataURL(), cropImage: crop.toDataURL(), transform: { rotation,
          crop: { x: x / rotated.width * 100, y: y / rotated.height * 100,
            width: side / rotated.width * 100, height: side / rotated.height * 100 } } }
      }, fixture)
      const sourcePath = join(root, `source-${index}.png`)
      await writeFile(sourcePath, Buffer.from(images.source.split(',')[1], 'base64'))
      await page.evaluate(async ({ sourcePath, transform, bytes }) => {
        await globalThis.gale.files.saveAvatarCrop({ sourcePath, transform, pngBytes: Uint8Array.from(bytes) })
      }, { sourcePath, transform: images.transform, bytes: [...Buffer.from(images.cropImage.split(',')[1], 'base64')] })
      for (let reopen = 0; reopen < 2; reopen++) {
        await open()
        await expect.poll(async () => cropDifference(await visibleCrop(page), images.transform.crop), {
          message: `Restored preview must match the saved crop (${JSON.stringify(fixture)}, reopen ${reopen}).`
        }).toBeLessThan(0.01)
        const stored = await saveAndRead()
        assert.equal(stored.rotation, fixture.rotation)
        assert.ok(cropDifference(stored.crop, images.transform.crop) < 0.00001, 'Saving without edits must not move the crop.')
      }
    }
    // Editing after restoration must not reapply the old transform on rotation or resize.
    await open()
    const slider = dialog.getByRole('slider')
    await slider.focus()
    await page.keyboard.press('ArrowRight')
    const preview = await page.locator('.avatar-crop-preview').boundingBox()
    await page.mouse.move(preview.x + preview.width / 2, preview.y + preview.height / 2)
    await page.mouse.down()
    await page.mouse.move(preview.x + preview.width / 2 - 35, preview.y + preview.height / 2 + 25, { steps: 4 })
    await page.mouse.up()
    await dialog.getByRole('button', { name: 'Rotate right', exact: true }).click()
    const edited = await visibleCrop(page)
    const stored = await saveAndRead()
    assert.equal(stored.rotation, 0)
    assert.ok(cropDifference(stored.crop, edited) < 0.01)
    await open()
    await expect.poll(async () => cropDifference(await visibleCrop(page), stored.crop)).toBeLessThan(0.01)
    await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
    const reset = await saveAndRead()
    assert.equal(reset.rotation, 0)
    assert.ok(cropDifference(reset.crop, { x: 0, y: 100 / 6, width: 100, height: 200 / 3 }) < 0.00001)
    assert.deepEqual(pageErrors, [])
    console.log('Avatar crop Electron E2E passed: repeated restoration of landscape, portrait, square, small and rotated images; zoom, drag, rotation and reset after reopening.')
  } finally {
    await closeElectronTestApplication(application)
    await rm(root, { recursive: true, force: true })
  }
}

module.exports = { verifyAvatarCrop }

const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, dirname, join } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')
const settingsDefaults = require('../data/config/settings.json')

function bitmap(width, height) {
  const stride = Math.ceil(width * 3 / 4) * 4
  const bytes = Buffer.alloc(54 + stride * height, 180)
  bytes.fill(0, 0, 54)
  bytes.write('BM')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(width, 18)
  bytes.writeInt32LE(height, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(24, 28)
  bytes.writeUInt32LE(stride * height, 34)
  return bytes
}

async function dropNativeFile(page, path) {
  // A real input File retains the OS path through Electron's getPathForFile.
  await page.evaluate(() => { const picker = globalThis.document.createElement('input'); picker.type = 'file'; picker.id = 'native-drop-test'; globalThis.document.body.append(picker) })
  await page.locator('#native-drop-test').setInputFiles(path)
  await page.evaluate(() => {
    const picker = globalThis.document.querySelector('#native-drop-test')
    const transfer = new globalThis.DataTransfer()
    transfer.items.add(picker.files[0])
    globalThis.document.querySelector('[data-agent-composer-input]').closest('form').dispatchEvent(new globalThis.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    picker.remove()
  })
}

async function verifyAttachmentPreviews(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-image-preview-e2e-'))
  if (dirname(root) !== tmpdir() || !basename(root).startsWith('anas-image-preview-e2e-')) throw new Error('Unexpected test directory.')
  const photo = join(root, '照片 #1 %.bmp')
  const tiny = join(root, '小图.bmp')
  const large = join(root, '超大 # %.bmp')
  const generatedName = 'generated 猫.bmp'
  const generated = join(root, generatedName)
  // Ordinary Windows filenames cannot end in a space; macOS exercises that case on disk.
  const nativePath = join(root, process.platform === 'win32' ? '报告 # 100%.txt' : '报告 # 100% ')
  const pathPrompt = `  请分析这个文件\n${nativePath}`
  const svg = join(root, 'diagram.svg')
  const svgSource = '<svg xmlns="http://www.w3.org/2000/svg"><text>附件文本</text></svg>'
  const profile = join(root, 'profile')
  let application
  let requests = 0
  const errors = []
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      const text = input.messages.flatMap(message => Array.isArray(message.content)
        ? message.content.filter(block => block.type === 'text').map(block => block.text) : []).join('\n')
      assert.ok(!text.includes('Archived path:'))
      assert.ok(!text.includes(join(profile, 'db', 'projects')))
      const images = input.messages.flatMap(message => Array.isArray(message.content)
        ? message.content.filter(block => block.type === 'image_url') : [])
      let content
      if (requests === 0) {
        assert.equal(images.length, 1)
        const labelText = `[Attachment: ${basename(photo)}]\nOriginal path: ${photo}`
        const label = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(block => block.type === 'text' && block.text === labelText)
        assert.ok(label)
        assert.ok(Buffer.from(images[0].image_url.url.split(',')[1], 'base64').length > 10 * 1024 * 1024)
        content = `Photo received.\n\n![Generated cat](${encodeURIComponent(generatedName)})`
          + `\n\n![Absolute cat](<${generated}>)`
          + `\n\n![Absolute photo](<${photo.replaceAll('%', '%25').replaceAll('#', '%23')}>)`
      } else if (requests === 1) {
        assert.equal(images.length, 0)
        assert.ok(input.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
          block.type === 'text' && block.text === `[Attachment: ${basename(photo)}]\nOriginal path: ${photo}`)))
        await assert.rejects(stat(photo), { code: 'ENOENT' })
        content = 'Historical image paths retained.'
      } else if (requests === 2) {
        assert.equal(images.length, 0)
        const user = input.messages.findLast(message => message.role === 'user')
        assert.equal(user.content.length, 2)
        assert.deepEqual(user.content[0], { type: 'text', text: pathPrompt })
        assert.deepEqual(user.content[1], { type: 'text', text: `Original path: ${svg}\n<file name="diagram.svg">\n${svgSource}\n</file>` })
        content = 'Native path and SVG source received.'
      } else {
        assert.equal(requests, 3)
        assert.equal(images.length, 1)
        content = 'Retained tiny image received.'
      }
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'photo-response', object: 'chat.completion', created: 1, model: input.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
          content } }],
        usage: { prompt_tokens: 2000, completion_tokens: 5, total_tokens: 2005 } }))
    })().catch(error => { errors.push(String(error)); response.writeHead(400); response.end(String(error)) })
  })
  try {
    await writeFile(photo, bitmap(2048, 1707))
    await writeFile(tiny, bitmap(8, 6))
    await writeFile(large, bitmap(3072, 3000))
    await writeFile(generated, bitmap(800, 600))
    await writeFile(nativePath, 'Convert this file without sending its contents.')
    await writeFile(svg, svgSource)
    await mkdir(join(profile, 'config'), { recursive: true })
    await writeFile(join(profile, 'config', 'settings.json'), JSON.stringify({ ...settingsDefaults, language: 'en' }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    application = await launchApplication(profile)
    const page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    await expect(page.locator('[data-agent-composer-input]')).toBeVisible()
    const projectUpdate = await page.evaluate(async sourceFolder => {
      const project = (await globalThis.gale.projects.list()).find(item => item.id === 'default-workspace')
      return globalThis.gale.projects.create({ ...project, name: 'Attachment previews', sourceFolders: [sourceFolder] })
    }, root)
    assert.equal(projectUpdate.status, 'ok')
    await page.reload()
    await expect(page.locator('[data-agent-composer-input]')).toBeVisible()
    await page.locator('.project-thread-group').filter({ hasText: projectUpdate.value.name }).locator('.project-thread-new-chat').click()
    await application.evaluate(({ shell }) => {
      globalThis.__anasRevealedImages = []
      // Keep the real preload/IPC validation; intercept only the OS file manager.
      shell.showItemInFolder = path => { globalThis.__anasRevealedImages.push(path) }
    })
    await page.evaluate(async port => {
      const api = globalThis.gale.config
      const config = await api.saveModelProvider({ name: 'Preview test', protocol: 'openai_chat_completions',
        baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', parameters: {}, modelListUrl: '' })
      const providerId = config.providers.find(provider => provider.name === 'Preview test').id
      await api.saveProviderModel({ providerId, displayName: 'Photo model', model: 'photo', parameters: {},
        imageLimits: { minShortSide: 10 },
        parameterPresetMode: 'none', capabilities: { vision: true, toolUse: false }, stream: false,
        maxContextTokens: 100000, maxOutputTokens: 1000, contextCompressionThreshold: 0.8, contextCompressionEnabled: true })
      await api.saveProviderModel({ providerId, displayName: 'Zero images', model: 'zero-images', parameters: {},
        imageLimits: { maxCount: 0 },
        parameterPresetMode: 'none', capabilities: { vision: true, toolUse: false }, stream: false,
        maxContextTokens: 100000, maxOutputTokens: 1000, contextCompressionThreshold: 0.8, contextCompressionEnabled: true })
    }, server.address().port)
    await page.getByRole('button', { name: 'Select model', exact: true }).click()
    await page.getByRole('menuitemradio', { name: /^Photo model(?: |$)/ }).click()
    const tile = page.locator('.attachment-grid-composer .attachment-tile')
    const input = page.locator('[data-agent-composer-input]')
    await mkdir(join(__dirname, '../tmp'), { recursive: true })
    for (const language of ['zh-CN', 'en']) {
      const chinese = language === 'zh-CN'
      await page.evaluate(language => globalThis.gale.config.updateSettings({ language }), language)
      await expect(page.locator('html')).toHaveAttribute('lang', language)
      const selectModel = async name => {
        await page.getByRole('button', { name: chinese ? '选择模型' : 'Select model', exact: true }).click()
        await page.getByRole('menuitemradio', { name: new RegExp(`^${name}(?: |$)`) }).click()
      }
      const attach = page.getByRole('button', { name: chinese ? '添加附件' : 'Attach file', exact: true })
      const send = page.getByRole('button', { name: chinese ? '发送' : 'Send', exact: true })
      const dimensions = chinese ? '图片尺寸为 8×6 像素：短边 6 像素，小于 10 像素的下限。'
        : 'Dimensions 8×6 px: short side 6 px is below the minimum of 10 px.'
      await input.fill('保留已有内容')
      await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, tiny)
      if (chinese) await dropNativeFile(page, tiny)
      else await attach.click()
      const warning = page.locator('[data-sonner-toast]').filter({ hasText: `小图.bmp: ${dimensions}` })
      await expect(warning).toBeVisible()
      await expect(tile).toHaveCount(0)
      await expect(input).toHaveValue('保留已有内容')
      if (chinese) await page.screenshot({ path: join(__dirname, '../tmp/image-validation-zh-CN.png') })
      await warning.locator('.notice-close').click()
      await expect(warning).not.toBeVisible()

      // Images accepted under one model must be checked again before sending to another.
      await selectModel('Zero images')
      await attach.click()
      await expect(tile).toHaveCount(1)
      await selectModel('Photo model')
      await send.click()
      await expect(page.getByText(`小图.bmp: ${dimensions}`, { exact: true })).toBeVisible()
      await selectModel('Zero images')
      await send.click()
      await expect(page.getByText(chinese ? '本次请求包含 1 张内嵌图片，超过 0 张的上限。'
        : 'This request contains 1 embedded images, exceeding the limit of 0.', { exact: true })).toBeVisible()
      await expect(input).toHaveValue('保留已有内容')
      await expect(tile).toHaveCount(1)
      assert.equal(requests, 0)
      await tile.hover()
      await tile.locator('.attachment-remove').click()
      await selectModel('Photo model')
    }
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, photo)
    await page.getByRole('button', { name: /attach file/i }).click()
    await input.fill('保留已有内容')
    await tile.hover()
    await expect(tile.getByRole('button', { name: 'Convert to path' })).toBeVisible()
    await page.screenshot({ path: join(__dirname, '../tmp/attachment-path-button.png') })
    await tile.getByRole('button', { name: 'Convert to path' }).click()
    await expect(tile).toHaveCount(0)
    await expect(input).toHaveValue(`保留已有内容\n${photo}`)
    await expect(input).toBeFocused()
    assert.equal(await input.evaluate(element => element.selectionStart), `保留已有内容\n${photo}`.length)

    const archive = join(root, '归档 # 100%.zip')
    const document = join(root, '会议记录 #1.docx')
    await writeFile(document, 'Converted only when requested')
    const folder = join(root, '未命名文件夹')
    await writeFile(archive, Buffer.from([0, 255, 0]))
    await mkdir(folder)
    await application.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }) }, [photo, archive, document, folder])
    await input.fill('继续分析\n')
    await page.getByRole('button', { name: /attach file/i }).click()
    await expect(tile).toHaveCount(1)
    await expect(input).toHaveValue(`继续分析\n${archive}\n${document}\n${folder}`)

    await input.fill('拖放文件')
    await dropNativeFile(page, archive)
    await expect(input).toHaveValue(`拖放文件\n${archive}`)
    await input.fill('')
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, photo)
    const remove = tile.locator('.attachment-remove')
    const contextToggle = tile.locator('.attachment-context-toggle')
    await page.locator('[data-agent-composer-input]').hover()
    await expect(remove).toHaveCSS('opacity', '0')
    await expect(contextToggle).toHaveCSS('opacity', '0')
    await tile.hover()
    await expect(remove).toHaveCSS('opacity', '1')
    await expect(contextToggle).toHaveCSS('opacity', '1')
    await contextToggle.click()
    await page.locator('[data-agent-composer-input]').hover()
    await expect(contextToggle).toHaveCSS('opacity', '0')
    await expect(remove).toHaveCSS('pointer-events', 'none')
    await tile.hover()
    await contextToggle.click()
    await page.locator('.attachment-grid-composer .attachment-open').click()
    const slide = page.locator('.yarl__slide_current .yarl__slide_image')
    await expect.poll(() => slide.evaluate(image => image.naturalWidth)).toBe(2048)
    await page.locator('.attachment-lightbox-folder-button').click()
    assert.deepEqual(await application.evaluate(() => globalThis.__anasRevealedImages), [photo])
    await page.keyboard.press('Escape')
    await page.locator('[data-agent-composer-input]').fill('Inspect the photo.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Photo received.', { exact: true })).toBeVisible()
    await page.locator('.attachment-grid-message .attachment-open').click()
    await expect(slide).toHaveAttribute('src', /^anas-image:/)
    await expect.poll(() => slide.evaluate(image => image.naturalWidth)).toBe(2048)
    await page.screenshot({ path: join(tmpdir(), 'anas-original-photo-preview.png') })
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Generated cat', exact: true }).click()
    await expect(slide).toHaveAttribute('src', /^anas-image:/)
    await expect.poll(() => slide.evaluate(image => image.naturalWidth)).toBe(800)
    await page.locator('.attachment-lightbox-folder-button').click()
    await expect.poll(async () => Promise.all((await application.evaluate(() => globalThis.__anasRevealedImages)).map(path => realpath(path))))
      .toEqual(await Promise.all([photo, generated].map(path => realpath(path))))
    await expect(page.getByText('Failed to open attachment.', { exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')

    for (const [name, path, width] of [['Absolute cat', generated, 800], ['Absolute photo', photo, 2048]]) {
      const thumbnail = page.getByRole('button', { name, exact: true })
      await expect(thumbnail).toBeVisible()
      await expect.poll(() => thumbnail.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0)
      await thumbnail.click()
      await expect(slide).toHaveAttribute('src', /^anas-image:/)
      await expect.poll(() => slide.evaluate(image => image.naturalWidth)).toBe(width)
      await page.locator('.attachment-lightbox-folder-button').click()
      await expect.poll(async () => realpath(await application.evaluate(() => globalThis.__anasRevealedImages.at(-1)))).toBe(await realpath(path))
      await page.keyboard.press('Escape')
    }
    await page.screenshot({ path: join(tmpdir(), 'anas-markdown-local-images.png') })

    // Historical image bytes and archive paths stay out of model context,
    // while the original path remains even if its file has disappeared.
    const photoBytes = await readFile(photo)
    await rm(photo)
    await input.fill('Keep the image paths for later reference.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Historical image paths retained.', { exact: true })).toBeVisible()
    await writeFile(photo, photoBytes)

    const largeResult = await page.evaluate(async path => {
      const preview = await globalThis.gale.files.readAttachmentPreview(path, { mode: 'original' })
      const image = new globalThis.Image()
      image.src = preview.src
      await image.decode()
      const [selected] = await globalThis.gale.files.readAttachments([path])
      return { width: image.naturalWidth, height: image.naturalHeight, rejected: selected.skippedReason }
    }, large)
    assert.equal(largeResult.width, 3072)
    assert.equal(largeResult.height, 3000)
    assert.match(largeResult.rejected, /exceeds 25 MB/)
    assert.equal(requests, 2)
    assert.deepEqual(errors, [])
    // Prepare the edit draft through its existing action, independent of the virtual history viewport.
    await page.getByRole('button', { name: 'Edit', exact: true }).first().evaluate(button => button.click())
    await page.getByRole('alertdialog').getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(tile).toHaveCount(1)
    await expect(tile.locator('.attachment-open')).toHaveAttribute('data-tooltip', photo)
    await tile.hover()
    await tile.getByRole('button', { name: 'Convert to path' }).click()
    await expect(tile).toHaveCount(0)
    await expect(input).toHaveValue(`Inspect the photo.\n${photo}`)
    const deletedThreadId = await page.evaluate(async projectId => {
      const thread = (await globalThis.gale.agent.threads.list()).find(thread => thread.projectId === projectId)
      await globalThis.gale.agent.threads.delete(thread.id)
      return thread.id
    }, projectUpdate.value.id)
    assert.deepEqual(await readFile(photo), photoBytes, 'Converting and deleting the conversation must preserve the original file.')
    await assert.rejects(stat(join(profile, 'db/projects', projectUpdate.value.id, 'conversations', deletedThreadId)), { code: 'ENOENT' })

    await page.reload()
    await expect(input).toBeVisible()
    await page.locator('.project-thread-group').filter({ hasText: projectUpdate.value.name }).locator('.project-thread-new-chat').click()
    await input.fill('')
    // Both the file dialog and a real drop must keep SVG source as an attachment.
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, svg)
    await page.getByRole('button', { name: /attach file/i }).click()
    await expect(tile).toHaveCount(1)
    await expect(input).toHaveValue('')
    await tile.hover()
    await tile.locator('.attachment-remove').click()
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, nativePath)
    await page.getByRole('button', { name: /attach file/i }).click()
    await input.fill('  请分析这个文件')
    await tile.hover()
    await tile.getByRole('button', { name: 'Convert to path' }).click()
    await expect(tile).toHaveCount(0)
    await expect(input).toHaveValue(pathPrompt)
    await dropNativeFile(page, svg)
    await expect(tile).toHaveCount(1)
    await expect(input).toHaveValue(pathPrompt)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Native path and SVG source received.', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.inputHistory.get()).items.map(item => item.text))).toContain(pathPrompt)
    assert.equal(requests, 3)
    assert.deepEqual(errors, [])

    // Retained historical images are validated by the main process, without new composer attachments.
    await page.evaluate(async () => {
      const config = await globalThis.gale.config.get()
      const providerId = config.providers.find(provider => provider.name === 'Preview test').id
      await globalThis.gale.config.saveProviderModel({ providerId, displayName: 'Unrestricted images', model: 'unrestricted', parameters: {},
        parameterPresetMode: 'none', capabilities: { vision: true, toolUse: false }, stream: false,
        maxContextTokens: 100000, maxOutputTokens: 1000, contextCompressionThreshold: 0.8, contextCompressionEnabled: true })
    })
    await page.locator('.project-thread-group').filter({ hasText: projectUpdate.value.name }).locator('.project-thread-new-chat').click()
    await page.getByRole('button', { name: 'Select model', exact: true }).click()
    await page.getByRole('menuitemradio', { name: /^Unrestricted images(?: |$)/ }).click()
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, tiny)
    await page.getByRole('button', { name: 'Attach file', exact: true }).click()
    await expect(tile).toHaveCount(1)
    await tile.hover()
    await tile.locator('.attachment-context-toggle').click()
    await input.fill('Retain this tiny image.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Retained tiny image received.', { exact: true })).toBeVisible()
    await expect(tile).toHaveCount(0)
    for (const language of ['zh-CN', 'en']) {
      const chinese = language === 'zh-CN'
      await page.evaluate(language => globalThis.gale.config.updateSettings({ language }), language)
      await expect(page.locator('html')).toHaveAttribute('lang', language)
      await input.fill('Keep this draft after historical image rejection.')
      for (const model of ['Photo model', 'Zero images']) {
        await page.getByRole('button', { name: chinese ? '选择模型' : 'Select model', exact: true }).click()
        await page.getByRole('menuitemradio', { name: new RegExp(`^${model}(?: |$)`) }).click()
        await page.getByRole('button', { name: chinese ? '发送' : 'Send', exact: true }).click()
        const error = page.locator('.thread-title.error')
        await expect(error).toContainText(model === 'Photo model'
          ? chinese ? '图片尺寸为 8×6 像素：短边 6 像素，小于 10 像素的下限。' : 'Dimensions 8×6 px: short side 6 px is below the minimum of 10 px.'
          : chinese ? '本次请求包含 1 张内嵌图片，超过 0 张的上限。' : 'This request contains 1 embedded images, exceeding the limit of 0.')
        await expect(error).not.toContainText('Error invoking remote method')
        if (chinese) await expect(error).not.toContainText(/Dimensions|Remove attachments|Change the attachment/)
        await expect(input).toHaveValue('Keep this draft after historical image rejection.')
        assert.equal(requests, 4)
      }
    }
    assert.deepEqual(errors, [])
    console.log('Attachment Electron E2E passed: localized composer and main-process historical image validation, preserved rejected drafts, native paths, SVG, drops, history editing, cleanup and previews.')
  } finally {
    await closeElectronTestApplication(application)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}

module.exports = { verifyAttachmentPreviews }

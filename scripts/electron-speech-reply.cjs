const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, dirname, join } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')
const settingsDefaults = require('../data/config/settings.json')

async function verifySpeechReply(launchApplication) {
  const home = await mkdtemp(join(tmpdir(), 'anas-speech-reply-'))
  if (dirname(home) !== tmpdir() || !basename(home).startsWith('anas-speech-reply-')) {
    throw new Error('Unexpected speech test directory.')
  }
  let application
  let requestCount = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      requestCount += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: `speech-test-${requestCount}`, object: 'chat.completion', created: 1,
        model: 'speech-test', choices: [{ index: 0, finish_reason: 'stop', message: {
          role: 'assistant', content: `Automatic reply ${requestCount}.`
        } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
    })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await mkdir(join(home, 'config'), { recursive: true })
    const settings = structuredClone(settingsDefaults)
    settings.language = 'en'
    settings.speech_reply.enabled = true
    await writeFile(join(home, 'config', 'settings.json'), `${JSON.stringify(settings)}\n`)
    application = await launchApplication(home)
    let page = await application.firstWindow()
    await page.locator('[data-agent-composer-input]').waitFor()
    await page.evaluate(async (port) => {
      const api = globalThis.gale.config
      const saved = await api.saveModelProvider({ name: 'Speech test', protocol: 'openai_chat_completions',
        baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', parameters: {}, modelListUrl: '', modelListAuth: 'bearer' })
      const providerId = saved.providers.find(provider => provider.name === 'Speech test').id
      const config = await api.saveProviderModel({ providerId, displayName: 'Speech test', model: 'speech-test',
        parameters: {}, parameterPresetMode: 'none', capabilities: { vision: false, toolUse: false }, stream: false,
        maxContextTokens: 32000, maxOutputTokens: 1024, contextCompressionThreshold: 0.8, contextCompressionEnabled: false })
      await api.selectDefaultModel(config.providers.find(provider => provider.id === providerId).models[0].id)
    }, server.address().port)
    await closeElectronTestApplication(application)
    application = await launchApplication(home)
    // Keep actual event delivery and audio playback; replace only the external
    // speech service with a short silent WAV to avoid network and audible output.
    await application.evaluate(({ ipcMain }) => {
      globalThis.__speechRequests = []
      ipcMain.removeHandler('speech:generate')
      ipcMain.handle('speech:generate', (_event, request) => {
        globalThis.__speechRequests.push(request.text)
        const samples = 800
        const audio = Buffer.alloc(44 + samples * 2)
        audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8)
        audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22)
        audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28)
        audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34)
        audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40)
        return audio
      })
    })
    page = await application.firstWindow()
    await page.locator('[data-agent-composer-input]').waitFor()
    await page.evaluate(() => {
      globalThis.__speechPlaybacks = 0
      const play = globalThis.HTMLMediaElement.prototype.play
      globalThis.HTMLMediaElement.prototype.play = async function () {
        await play.call(this)
        globalThis.__speechPlaybacks += 1
      }
    })
    await expect(page.getByRole('button', { name: 'Automatic speech reply', exact: true })).toHaveAttribute('aria-pressed', 'true')
    for (let index = 1; index <= 2; index += 1) {
      if (index > 1) await page.getByRole('button', { name: 'New Session', exact: true }).click()
      await page.locator('[data-agent-composer-input]').fill(`Test first reply in new thread ${index}.`)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect.poll(() => application.evaluate(() => globalThis.__speechRequests), { timeout: 20000 })
        .toEqual(Array.from({ length: index }, (_, item) => `Automatic reply ${item + 1}.`))
      await expect.poll(() => page.evaluate(() => globalThis.__speechPlaybacks)).toBe(index)
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    }
    assert.equal(requestCount, 2)
    console.log('Automatic speech passed: persisted startup setting, first replies in two new threads, and native audio playback without toggling.')
  } finally {
    await closeElectronTestApplication(application)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
}

module.exports = { verifySpeechReply }

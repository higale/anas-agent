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
  let beginToolReply
  let finishToolCall
  let finishToolReply
  const fixture = join(home, 'speech-fixture.txt')
  const toolReply = 'I will read the file before giving the answer.'
  const finalReply = 'The file was read. Here is the final answer.'
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      requestCount += 1
      const index = requestCount
      const toolCalls = [{ index: 0, id: `speech-read-${index}`, type: 'function', function: {
        name: 'read_file', arguments: JSON.stringify({ path: fixture })
      } }]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
      const delta = (value, finishReason = null) => response.write(`data: ${JSON.stringify({
        id: `speech-test-${index}`, object: 'chat.completion.chunk', created: 1, model: 'speech-test',
        choices: [{ index: 0, delta: value, finish_reason: finishReason }]
      })}\n\n`)
      const finish = (content, withTools = false) => {
        delta({ role: 'assistant', content, ...(withTools ? { tool_calls: toolCalls } : {}) })
        delta({}, withTools ? 'tool_calls' : 'stop')
        response.end('data: [DONE]\n\n')
      }
      if (index === 3) {
        beginToolReply = () => delta({ role: 'assistant', content: toolReply })
        finishToolCall = () => finish('', true)
      } else if (index === 4 || index === 6) {
        // Keep the next reply pending so playback can be checked during tool work.
        finishToolReply = () => finish(finalReply)
      } else if (index === 5) finish(toolReply, true)
      else finish(`Automatic reply ${index}.`)
    })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await mkdir(join(home, 'config'), { recursive: true })
    const settings = structuredClone(settingsDefaults)
    settings.language = 'en'
    settings.speech_reply.enabled = true
    await writeFile(join(home, 'config', 'settings.json'), `${JSON.stringify(settings)}\n`)
    await writeFile(fixture, 'SPEECH_TOOL_FIXTURE')
    application = await launchApplication(home)
    let page = await application.firstWindow()
    await page.locator('[data-agent-composer-input]').waitFor()
    await page.evaluate(async ({ port, home }) => {
      const api = globalThis.gale.config
      const saved = await api.saveModelProvider({ name: 'Speech test', protocol: 'openai_chat_completions',
        baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', parameters: {}, modelListUrl: '', modelListAuth: 'bearer' })
      const providerId = saved.providers.find(provider => provider.name === 'Speech test').id
      const config = await api.saveProviderModel({ providerId, displayName: 'Speech test', model: 'speech-test',
        parameters: {}, parameterPresetMode: 'none', capabilities: { vision: false, toolUse: true }, stream: true,
        maxContextTokens: 32000, maxOutputTokens: 1024, contextCompressionThreshold: 0.8, contextCompressionEnabled: false })
      await api.selectDefaultModel(config.providers.find(provider => provider.id === providerId).models[0].id)
      const base = (await globalThis.gale.projects.list()).find(project => project.id === 'default-workspace')
      const project = await globalThis.gale.projects.create({ ...base, name: 'Speech tool fixture', sourceFolders: [home] })
      if (project.status !== 'ok') throw new Error(JSON.stringify(project))
      await globalThis.gale.agent.workspace.set({ mode: 'new_thread', projectId: project.value.id, modelParameterPresetId: null })
    }, { port: server.address().port, home })
    await closeElectronTestApplication(application)
    application = await launchApplication(home)
    // Keep actual event delivery and audio playback; replace only the external
    // speech service with silent WAVs to avoid network and audible output.
    await application.evaluate(({ ipcMain }) => {
      globalThis.__speechRequests = []
      ipcMain.removeHandler('speech:generate')
      ipcMain.handle('speech:generate', (_event, request) => {
        globalThis.__speechRequests.push(request.text)
        const samples = request.text.startsWith('Automatic reply') ? 800 : 80000
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
      globalThis.__speechPlayers = []
      const play = globalThis.HTMLMediaElement.prototype.play
      globalThis.HTMLMediaElement.prototype.play = async function () {
        await play.call(this)
        globalThis.__speechPlaybacks += 1
        globalThis.__speechPlayers.push(this)
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
    await page.getByRole('button', { name: 'New Session', exact: true }).click()
    await page.locator('[data-agent-composer-input]').fill('Read the speech fixture and report the result.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => typeof beginToolReply, { timeout: 20000 }).toBe('function')
    // Deliver text after the first streaming chunk's minimum age, then wait for
    // native playback before revealing the tool call.
    await page.waitForTimeout(600)
    beginToolReply()
    await expect.poll(() => page.evaluate(() => globalThis.__speechPlayers.length)).toBe(3)
    await expect.poll(() => page.evaluate(() => globalThis.__speechPlayers[2].currentTime)).toBeGreaterThan(0)
    finishToolCall()
    await expect.poll(() => typeof finishToolReply, { timeout: 20000 }).toBe('function')
    assert.equal(requests[3].messages.at(-1).role, 'tool')
    assert.match(JSON.stringify(requests[3].messages.at(-1).content), /SPEECH_TOOL_FIXTURE/)
    await expect.poll(() => application.evaluate(() => globalThis.__speechRequests)).toEqual(['Automatic reply 1.', 'Automatic reply 2.', toolReply])
    await expect.poll(() => page.evaluate(() => globalThis.__speechPlayers.length)).toBe(3)
    await expect.poll(() => page.evaluate(() => globalThis.__speechPlayers[2].currentTime)).toBeGreaterThan(0)
    assert.equal(await page.evaluate(() => globalThis.__speechPlayers[2].paused), false, 'Tools and the next model request must not stop speech.')
    finishToolReply()
    await expect.poll(() => application.evaluate(() => globalThis.__speechRequests)).toEqual(['Automatic reply 1.', 'Automatic reply 2.', toolReply, finalReply])
    await expect.poll(() => page.evaluate(() => globalThis.__speechPlayers.length)).toBe(4)
    assert.equal(await page.evaluate(() => globalThis.__speechPlayers[2].paused), true, 'New body text must stop old audio.')
    assert.equal(await page.evaluate(() => globalThis.__speechPlayers[3].paused), false, 'New reply audio must play.')
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    assert.equal(await application.evaluate(() => globalThis.__speechRequests.length), 4, 'Run completion must not replay the final reply.')
    assert.equal(requestCount, 4)

    finishToolReply = undefined
    await page.getByRole('button', { name: 'New Session', exact: true }).click()
    await page.locator('[data-agent-composer-input]').fill('Read the speech fixture again.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => typeof finishToolReply, { timeout: 20000 }).toBe('function')
    assert.equal(requests[5].messages.at(-1).role, 'tool')
    assert.match(JSON.stringify(requests[5].messages.at(-1).content), /SPEECH_TOOL_FIXTURE/)
    assert.equal(await application.evaluate(() => globalThis.__speechRequests.length), 4, 'Tools arriving before playback must discard pending narration.')
    assert.equal(await page.evaluate(() => globalThis.__speechPlayers.length), 4)
    finishToolReply()
    await expect.poll(() => page.evaluate(() => globalThis.__speechPlayers.length)).toBe(5)
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    assert.deepEqual(await application.evaluate(() => globalThis.__speechRequests), ['Automatic reply 1.', 'Automatic reply 2.', toolReply, finalReply, finalReply])
    assert.equal(requestCount, 6)
    console.log('Automatic speech passed: persisted startup setting, new threads, native audio continuing through tools, unstarted narration cancelled, switching on new body text, and no final replay.')
  } finally {
    await closeElectronTestApplication(application)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
}

module.exports = { verifySpeechReply }

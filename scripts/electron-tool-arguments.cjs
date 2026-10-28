const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, dirname, basename } = require('node:path')
const { expect } = require('playwright/test')

async function verifyToolArguments(launchApplication) {
  const home = await mkdtemp(join(tmpdir(), 'anas-tool-arguments-'))
  if (dirname(home) !== tmpdir() || !basename(home).startsWith('anas-tool-arguments-')) throw new Error('Unexpected test directory')
  let app
  try {
    app = await launchApplication(home)
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.locator('[data-agent-composer-input]').waitFor()
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const now = new Date().toISOString()
      const thread = { id: 'arguments-thread', projectId: 'default-workspace', title: 'Tool arguments',
        status: 'idle', accessMode: 'smart_approval', pinned: false, userTurnCount: 1, createdAt: now, updatedAt: now }
      const snapshot = { thread, messages: [{ id: 'user', role: 'user', runId: 'arguments-run', content: [{ type: 'text', text: 'Argument reception probe' }] }],
        activities: [], todos: [], interrupts: [], messageWindow: { startIndex: 0, shown: 1, total: 1, remaining: 0 } }
      globalThis.__toolArgumentEvents = []
      globalThis.__sendToolArgumentEvent = (event) => {
        const envelope = { revision: globalThis.__toolArgumentEvents.length + 1, replayActive: true, event }
        globalThis.__toolArgumentEvents.push(envelope)
        BrowserWindow.getAllWindows()[0].webContents.send('agent:event', envelope)
      }
      for (const [channel, handler] of [
        ['agent:threads:list', () => [thread]], ['agent:threads:get', () => snapshot],
        ['agent:workspace:get', () => ({ mode: 'thread', threadId: thread.id })],
        ['agent:runs:recover', (_event, threadId) => {
          if (threadId !== thread.id) throw new Error('Unexpected conversation in fixture recovery')
          return false
        }],
        ['agent:events:subscribe', () => ({ revision: globalThis.__toolArgumentEvents.length, replay: globalThis.__toolArgumentEvents, replayComplete: true })]
      ]) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
    })
    await page.reload()
    await expect(page.getByText('Argument reception probe')).toBeVisible()
    const common = { runId: 'arguments-run', threadId: 'arguments-thread' }
    const send = (event) => app.evaluate((_electron, event) => globalThis.__sendToolArgumentEvent(event), event)
    const now = new Date().toISOString()
    await send({ type: 'run_started', run: { id: common.runId, threadId: common.threadId, operation: 'agent', status: 'running', createdAt: now, updatedAt: now }, newUserTurn: false })
    const panel = page.locator('.agent-message-panel')
    const position = () => panel.evaluate((element) => ({ top: element.scrollTop,
      gap: element.scrollHeight - element.clientHeight - element.scrollTop }))
    assert.deepEqual(await position(), { top: 0, gap: 0 }, 'The short conversation must initially fit without scrolling.')
    const initialBounds = await panel.boundingBox()
    await page.mouse.move(initialBounds.x + initialBounds.width / 2, initialBounds.y + initialBounds.height / 2)
    await page.mouse.wheel(0, -100)
    await page.evaluate(() => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))))
    const model = { id: 'model', sequence: 0, status: 'running', text: '', reasoning: 'Thinking line\n'.repeat(100), toolCallIds: [] }
    await send({ ...common, type: 'model_started', model })
    await expect(page.locator('.agent-activity-reasoning[open] pre')).toBeVisible()
    await expect.poll(async () => (await position()).gap).toBeLessThan(3)
    const progress = { index: 0, name: 'apply_patch', characterCount: 1, complete: false }
    await send({ ...common, type: 'model_tool_calls', modelId: model.id, progress: [progress] })
    const card = page.locator('.agent-activity-tool')
    const summary = card.locator(':scope > summary')
    await expect(summary).toHaveAttribute('aria-disabled', 'true')
    await expect(card.locator(':scope.agent-tool-running > summary')).toHaveCount(0)
    // Native details activation is tested in Chromium for both mouse and keyboard.
    await summary.click({ force: true })
    for (const key of ['Enter', 'Space']) {
      await summary.focus()
      await page.keyboard.press(key)
      assert.equal(await card.evaluate((element) => element.open), false)
    }
    await expect(card.locator('pre')).toHaveCount(0)
    for (const characterCount of [500, 10_000, 100_000]) {
      await send({ ...common, type: 'model_tool_calls', modelId: model.id, progress: [{ ...progress, characterCount }] })
    }
    await expect(summary).toContainText('100000')
    await expect(card.locator('.agent-activity-arguments')).toHaveCount(0)
    if (process.env.ANAS_E2E_ARGUMENTS_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_ARGUMENTS_SCREENSHOT })
    await send({ ...common, type: 'model_tool_calls', modelId: model.id, progress: [{ ...progress, callId: 'provider-tool', characterCount: 100_000, complete: true }] })
    await expect(summary).toHaveAttribute('aria-disabled', 'true')
    // A downward wheel at the bottom must not linger as upward intent when
    // reasoning automatically collapses at the model/tool transition.
    const bounds = await panel.boundingBox()
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 30)
    await page.mouse.wheel(0, 200)
    await send({ ...common, type: 'model_completed', model: { ...model, status: 'completed', toolCallIds: ['tool'] } })
    const call = { id: 'tool', name: 'apply_patch', args: { patch: 'FULL_ARGUMENT_BEGIN' + 'x'.repeat(100_000) + 'FULL_ARGUMENT_END' } }
    await send({ ...common, type: 'tool_started', call, sequence: 1, startedAt: now })
    await expect(summary).not.toHaveAttribute('aria-disabled')
    await expect(card).toHaveCount(1)
    await expect(card.locator(':scope.agent-tool-running > summary')).toHaveText('apply_patch')
    assert.equal(await card.locator(':scope.agent-tool-running > summary').evaluate(element => element.getAnimations().filter(animation => animation.animationName === 'agent-tool-shimmer').length), 1)
    assert.equal(await card.evaluate((element) => element.open), false)
    await expect(card.locator('pre')).toHaveCount(0)
    const nextModel = { ...model, id: 'model-next', sequence: 2 }
    await send({ ...common, type: 'model_started', model: nextModel })
    await expect(page.locator('.agent-activity-reasoning[open] pre')).toBeVisible()
    await expect.poll(async () => (await position()).gap).toBeLessThan(3)
    await panel.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home')
    await expect.poll(async () => (await position()).gap).toBeGreaterThan(50)
    const keyboardTop = (await position()).top
    await send({ ...common, type: 'model_delta', modelId: nextModel.id,
      delta: { type: 'reasoning', text: 'After keyboard navigation\n'.repeat(20) } })
    await expect(page.locator('.agent-activity-reasoning[open] pre')).toContainText('After keyboard navigation')
    await page.evaluate(() => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))))
    assert.ok((await position()).top <= keyboardTop + 2, 'Keyboard navigation must pause output following.')
    await page.getByRole('button', { name: /^(滚动到底部|Scroll to bottom)$/ }).click()
    await expect.poll(async () => (await position()).gap).toBeLessThan(3)
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 30)
    await page.mouse.wheel(0, -150)
    await expect.poll(async () => (await position()).gap).toBeGreaterThan(50)
    const pausedTop = (await position()).top
    await send({ ...common, type: 'model_delta', modelId: nextModel.id,
      delta: { type: 'reasoning', text: 'More reasoning\n'.repeat(40) } })
    await expect(page.locator('.agent-activity-reasoning[open] pre')).toContainText('More reasoning')
    assert.ok((await position()).top <= pausedTop + 2, 'User scrolling upward must pause output following.')
    await page.getByRole('button', { name: /^(滚动到底部|Scroll to bottom)$/ }).click()
    await expect.poll(async () => (await position()).gap).toBeLessThan(3)
    // Drag Chromium's actual scrollbar, then ensure new output does not take
    // the reader away from the chosen position after releasing the pointer.
    const scrollbar = await panel.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const width = Math.max(element.offsetWidth - element.clientWidth, 6)
      const trackHeight = element.clientHeight - 2 * width
      const thumbHeight = trackHeight * element.clientHeight / element.scrollHeight
      // Start inside the thumb, clear of native arrow buttons and rounded edges.
      return { x: bounds.right - width / 2, y: bounds.bottom - width - thumbHeight / 2 }
    })
    await page.mouse.move(scrollbar.x, scrollbar.y)
    await page.mouse.down()
    await page.mouse.move(scrollbar.x, scrollbar.y - 80, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await position()).gap).toBeGreaterThan(50)
    const draggedTop = (await position()).top
    await send({ ...common, type: 'model_delta', modelId: nextModel.id,
      delta: { type: 'reasoning', text: 'After scrollbar drag\n'.repeat(20) } })
    await expect(page.locator('.agent-activity-reasoning[open] pre')).toContainText('After scrollbar drag')
    assert.ok((await position()).top <= draggedTop + 2, 'Scrollbar dragging must pause output following.')
    await page.getByRole('button', { name: /^(滚动到底部|Scroll to bottom)$/ }).click()
    await expect.poll(async () => (await position()).gap).toBeLessThan(3)
    await page.mouse.click(scrollbar.x, bounds.y + bounds.height / 2)
    await expect.poll(async () => (await position()).gap).toBeGreaterThan(50)
    const trackTop = (await position()).top
    await send({ ...common, type: 'model_delta', modelId: nextModel.id,
      delta: { type: 'reasoning', text: 'After scrollbar track click\n'.repeat(20) } })
    await expect(page.locator('.agent-activity-reasoning[open] pre')).toContainText('After scrollbar track click')
    await page.evaluate(() => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))))
    assert.ok((await position()).top <= trackTop + 2, 'A scrollbar track click must pause output following.')
    await page.getByRole('button', { name: /^(滚动到底部|Scroll to bottom)$/ }).click()
    await expect.poll(async () => (await position()).gap).toBeLessThan(3)
    await send({ ...common, type: 'model_completed', model: { ...nextModel, status: 'completed' } })
    await summary.click()
    const args = card.locator('.agent-activity-arguments')
    await expect(args.locator('pre')).toHaveCount(0)
    await args.locator('summary').click()
    await expect(args.locator('pre')).toHaveText(JSON.stringify(call.args, null, 2))
    await send({ ...common, type: 'tool_completed', call, sequence: 1, startedAt: now, completedAt: now, output: 'Tool completed' })
    await expect(card.locator('.agent-activity-result')).toBeVisible()
    await expect(args.locator('pre')).toHaveText(JSON.stringify(call.args, null, 2))
    await expect(card.locator('.agent-activity-result pre')).toHaveCount(0)
    await expect(card.locator(':scope.agent-tool-running > summary')).toHaveCount(0)
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'zh-CN', theme: 'dark' }))
    const sleepStarted = new Date(Date.now() - 5000).toISOString()
    const sleepCall = { id: 'sleep', name: 'sleep', args: { seconds: 15, summary: '等待新回复' } }
    await send({ ...common, type: 'tool_started', call: sleepCall, sequence: 5, startedAt: sleepStarted })
    const sleepCard = page.locator('.agent-activity-tool').filter({ has: page.locator('code').filter({ hasText: /^sleep$/ }) })
    const countdown = sleepCard.getByRole('timer')
    await sleepCard.scrollIntoViewIfNeeded()
    await expect(sleepCard.locator(':scope > summary .lucide-clock')).toBeVisible()
    await expect(countdown).toHaveText('剩余 10 秒')
    const firstBounds = await countdown.boundingBox()
    const labelBounds = await sleepCard.locator(':scope > summary .agent-activity-summary-label').boundingBox()
    const gap = firstBounds.x - labelBounds.x - labelBounds.width
    assert.ok(gap >= 4 && gap <= 8, 'Countdown follows the tool text with a small gap.')
    await expect(countdown).toHaveText('剩余 9 秒')
    const nextBounds = await countdown.boundingBox()
    assert.ok(Math.abs(firstBounds.x - nextBounds.x) < 1, 'Countdown stays beside the text as digits change.')
    const shimmer = sleepCard.locator(':scope.agent-tool-running > summary')
    await expect(shimmer).toContainText('sleep')
    await expect(shimmer).toContainText('等待新回复')
    await expect(shimmer.locator('.agent-activity-summary-icon svg')).toBeVisible()
    await expect(shimmer.getByRole('timer')).toBeVisible()
    assert.equal(await countdown.evaluate(element => element.getAnimations().length), 0)
    const freezeShimmer = async () => {
      const positions = await shimmer.evaluate(element => {
        const animation = element.getAnimations().find(animation => animation.animationName === 'agent-tool-shimmer')
        animation.pause()
        animation.currentTime = 0
        const start = globalThis.getComputedStyle(element).maskPosition
        animation.currentTime = Number(animation.effect.getTiming().duration) / 2
        return [start, globalThis.getComputedStyle(element).maskPosition]
      })
      assert.notEqual(positions[0], positions[1], 'The gradient moves across the text.')
    }
    await freezeShimmer()
    await sleepCard.screenshot({ path: join(tmpdir(), 'anas-sleep-dark.png') })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reduced = await shimmer.evaluate(element => ({ animations: element.getAnimations().filter(animation => animation.animationName === 'agent-tool-shimmer').length,
      color: globalThis.getComputedStyle(element).color, mask: globalThis.getComputedStyle(element).maskImage }))
    assert.deepEqual({ animations: reduced.animations, mask: reduced.mask }, { animations: 0, mask: 'none' })
    assert.notEqual(reduced.color, 'rgba(0, 0, 0, 0)', 'Reduced motion keeps the text readable.')
    assert.ok((await shimmer.locator('.agent-activity-summary-label > *').evaluateAll(elements => elements.map(element => globalThis.getComputedStyle(element).color)))
      .every(color => color !== 'rgba(0, 0, 0, 0)'), 'Both name and summary remain readable with reduced motion.')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en', theme: 'light' }))
    await expect(countdown).toHaveText(/^\d+ s remaining$/)
    await freezeShimmer()
    await sleepCard.screenshot({ path: join(tmpdir(), 'anas-sleep-light.png') })
    const completedAt = new Date().toISOString()
    await send({ ...common, type: 'tool_completed', call: sleepCall, sequence: 5, startedAt: sleepStarted, completedAt,
      output: { status: 'completed', elapsed_seconds: (Date.parse(completedAt) - Date.parse(sleepStarted)) / 1000 } })
    await expect(countdown).toHaveCount(0)
    await expect(shimmer).toHaveCount(0)
    await expect(sleepCard.locator(':scope > summary')).toContainText(/· \d+(\.\d+)? s/)
    console.log('Tool arguments E2E passed: reception, expansion lock, late IDs, lazy details, automatic collapse and user-controlled output following.')
    console.log('Sleep UI E2E passed: clock icon, countdown alignment, both themes and languages, completed duration.')
    console.log('Tool shimmer E2E passed: names, summaries, icons and countdown in one moving mask, reduced motion and completion cleanup.')
  } finally {
    await app?.close()
    await rm(home, { recursive: true, force: true })
  }
}

module.exports = { verifyToolArguments }

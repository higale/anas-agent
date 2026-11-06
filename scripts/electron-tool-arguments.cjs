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
    await page.evaluate(() => globalThis.gale.config.updateSettings({ runningProcessDisplay: 'collapsed' }))
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const now = new Date().toISOString()
      const thread = { id: 'arguments-thread', projectId: 'default-workspace', title: 'Tool arguments',
        status: 'idle', accessMode: 'smart_approval', pinned: false, userTurnCount: 1, createdAt: now, updatedAt: now }
      const snapshot = { thread, messages: [{ id: 'user', role: 'user', runId: 'arguments-run', content: [{ type: 'text', text: 'Argument reception probe' }] }],
        activities: [], todos: [], interrupts: [], messageWindow: { startIndex: 0, shown: 1, total: 1, remaining: 0 } }
      globalThis.__toolArgumentEvents = []
      globalThis.__toolArgumentDirectoryReads = 0
      const activity = { runId: 'arguments-run', operation: 'agent', status: 'running', createdAt: now, updatedAt: now,
        models: [], tools: [], subagents: [] }
      const upsert = (items, item, id) => { const index = items.findIndex(id); if (index < 0) items.push(item); else items[index] = item }
      const reference = (kind, id) => ({ threadId: thread.id, runId: activity.runId, kind, id })
      globalThis.__sendToolArgumentEvent = (event) => {
        if (event.type === 'model_started' || event.type === 'model_completed') upsert(activity.models, event.model, item => item.id === event.model.id)
        if (event.type === 'model_delta') {
          const model = activity.models.find(item => item.id === event.modelId)
          model[event.delta.type] += event.delta.text
        }
        if (event.type === 'model_tool_calls') activity.models.find(item => item.id === event.modelId).toolCallProgress = event.progress
        if (event.type === 'tool_started' || event.type === 'tool_approval_requested' || event.type === 'tool_completed') upsert(activity.tools,
          { ...event, status: event.type === 'tool_completed' ? 'completed' : 'running' }, item => item.call.id === event.call.id)
        const envelope = { revision: globalThis.__toolArgumentEvents.length + 1, replayActive: true, event }
        globalThis.__toolArgumentEvents.push(envelope)
        BrowserWindow.getAllWindows()[0].webContents.send('agent:event', envelope)
      }
      for (const [channel, handler] of [
        ['agent:activities:directory', (_event, input) => {
          globalThis.__toolArgumentDirectoryReads++
          const entries = [], keys = new Map()
          const add = (item, sequence, part = 1) => { const position = { sequence, part, key: item.key }; entries.push({ type: 'entry', item, key: item.key, position, start: position, end: position }) }
          for (const model of activity.models) {
            const key = `model:root:${model.id}`
            add({ type: 'model', key, round: model.round, showText: false, model: { ...model, hasText: !!model.text, hasReasoning: !!model.reasoning,
              text: '', reasoning: '', detail: reference('model', model.id) } }, model.sequence)
            model.toolCallIds.forEach((id, index) => keys.set(id, `model-tool:root:${model.id}:${index}`))
            if (model.status === 'running') for (const [index, progress] of (model.toolCallProgress || []).entries()) {
              const id = model.toolCallIds[index] || progress.callId || `${model.id}:draft:${index}`
              if (!activity.tools.some(tool => tool.call.id === id)) add({ type: 'tool', key: `model-tool:root:${model.id}:${index}`, progress,
                tool: { call: { id, name: progress.name }, sequence: model.sequence, status: 'running' } }, model.sequence, index + 3)
            }
          }
          for (const tool of activity.tools) add({ type: 'tool', key: keys.get(tool.call.id) || `tool:${tool.call.id}`,
            tool: { ...tool, call: { ...tool.call, args: { summary: tool.call.args.summary, seconds: tool.call.args.seconds } }, output: undefined,
              detail: reference('tool', tool.call.id) } }, tool.sequence)
          entries.sort((a, b) => a.start.sequence - b.start.sequence || a.start.part - b.start.part)
          if (!entries.length) return { version: String(globalThis.__toolArgumentEvents.length), items: [], removed: [] }
          const key = `process:${entries[0].key}`, active = entries.findLast(entry => entry.item.type === 'tool' ? entry.item.tool.status === 'running' : entry.item.model.status === 'running')?.item
          const attention = entries.find(entry => entry.item.type === 'tool' && entry.item.tool.approval)?.item
          const group = { type: 'process', key, first: entries[0].item, active, attention, hasThought: activity.models.some(model => model.reasoning),
            hasTools: entries.some(entry => entry.item.type === 'tool'), start: entries[0].start, end: entries.at(-1).end }
          const replyModel = activity.models.findLast(model => model.text)
          const replyPosition = replyModel && { sequence: replyModel.sequence, part: 2, key: `text:model:root:${replyModel.id}` }
          const replies = replyModel ? [{ type: 'reply', model: { ...replyModel, text: '', hasText: true, detail: reference('model', replyModel.id) },
            key: replyPosition.key, position: replyPosition, start: replyPosition, end: replyPosition }] : []
          return { version: String(globalThis.__toolArgumentEvents.length), items: input.parentId ? entries : [group, ...replies], removed: [] }
        }],
        ['agent:activities:detail', (_event, input) => input.kind === 'model'
          ? activity.models.find(item => item.id === input.id)
          : (() => { const tool = activity.tools.find(item => item.call.id === input.id); return { args: tool.call.args, output: tool.output } })()],
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
    const settleScroll = () => panel.evaluate(element => new Promise(resolve => {
      let previous = element.scrollTop, stable = 0, frames = 0
      const check = () => {
        const top = element.scrollTop
        stable = Math.abs(top - previous) < 0.5 ? stable + 1 : 0
        previous = top
        if (stable >= 6 || ++frames >= 180) resolve()
        else globalThis.requestAnimationFrame(check)
      }
      globalThis.requestAnimationFrame(check)
    }))
    assert.deepEqual(await position(), { top: 0, gap: 0 }, 'The short conversation must initially fit without scrolling.')
    const initialBounds = await panel.boundingBox()
    await page.mouse.move(initialBounds.x + initialBounds.width / 2, initialBounds.y + initialBounds.height / 2)
    await page.mouse.wheel(0, -100)
    await page.evaluate(() => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))))
    const model = { id: 'model', round: 1, startedAt: now, sequence: 0, status: 'running', text: '', reasoning: 'Thinking line\n'.repeat(100), toolCallIds: [] }
    await send({ ...common, type: 'model_started', model })
    const runStatus = page.locator('.agent-activity-range-status')
    await expect(runStatus).toBeVisible()
    await expect(runStatus.locator('svg')).toHaveCount(0)
    const elapsed = runStatus.locator('.agent-run-elapsed')
    let elapsedText = await elapsed.textContent()
    await expect.poll(() => elapsed.textContent()).not.toBe(elapsedText)
    const idleReads = await app.evaluate(() => globalThis.__toolArgumentDirectoryReads)
    elapsedText = await elapsed.textContent()
    await expect.poll(() => elapsed.textContent()).not.toBe(elapsedText)
    assert.equal(await app.evaluate(() => globalThis.__toolArgumentDirectoryReads), idleReads, 'Elapsed ticks must not reload activity data.')
    const roundHeader = page.locator('.agent-activity-model > header').filter({ hasText: 'round 1' })
    await expect(roundHeader).toHaveCount(0)
    await page.locator('.agent-activity-process > summary').click()
    await expect(roundHeader).toBeVisible()
    await expect(page.locator('.agent-activity-reasoning[open] pre')).toBeVisible()
    // Opening the group can leave the reader at the top of the long detail.
    if ((await position()).gap > 2) await page.getByRole('button', { name: /^(滚动到底部|Scroll to bottom)$/ }).click()
    await expect.poll(async () => (await position()).gap).toBeLessThan(3)
    await page.locator('.agent-activity-reasoning[open] > summary').evaluate(row => row.click())
    const progress = { index: 0, name: 'apply_patch', characterCount: 1, complete: false }
    await send({ ...common, type: 'model_tool_calls', modelId: model.id, progress: [progress] })
    await expect(page.locator('.agent-activity-process[open]')).toBeVisible()
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
    await send({ ...common, type: 'model_completed', model: { ...model, status: 'completed',
      completedAt: new Date(Date.parse(now) + 1900).toISOString(), toolCallIds: ['tool'] } })
    await expect(roundHeader).toContainText('1.9 s')
    const reasoning = page.locator('[data-activity-item="model:root:model"] .agent-activity-reasoning')
    const call = { id: 'tool', name: 'apply_patch', args: { patch: 'FULL_ARGUMENT_BEGIN' + 'x'.repeat(100_000) + 'FULL_ARGUMENT_END' } }
    await send({ ...common, type: 'tool_started', call, sequence: 1, startedAt: now })
    await expect(summary).not.toHaveAttribute('aria-disabled')
    await expect(card).toHaveCount(1)
    await expect(card.locator(':scope.agent-tool-running > summary')).toHaveText('apply_patch')
    assert.equal(await card.locator(':scope.agent-tool-running > summary').evaluate(element => element.getAnimations().filter(animation => animation.animationName === 'agent-tool-shimmer').length), 1)
    assert.equal(await card.evaluate((element) => element.open), false)
    await expect(card.locator('pre')).toHaveCount(0)
    const nextModel = { ...model, id: 'model-next', round: 2, sequence: 2 }
    await send({ ...common, type: 'model_started', model: nextModel })
    await expect(page.locator('.agent-activity-reasoning[open] pre')).toBeVisible()
    // Opening the group can leave the reader at the top of the long detail.
    if ((await position()).gap > 2) await page.getByRole('button', { name: /^(滚动到底部|Scroll to bottom)$/ }).click()
    await expect.poll(async () => (await position()).gap).toBeLessThan(3)
    await panel.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home')
    await expect.poll(async () => (await position()).gap).toBeGreaterThan(50)
    await settleScroll()
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
    await settleScroll()
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
    await settleScroll()
    const draggedTop = (await position()).top
    await send({ ...common, type: 'model_delta', modelId: nextModel.id,
      delta: { type: 'reasoning', text: 'After scrollbar drag\n'.repeat(20) } })
    await expect(page.locator('.agent-activity-reasoning[open] pre')).toContainText('After scrollbar drag')
    assert.ok((await position()).top <= draggedTop + 2, 'Scrollbar dragging must pause output following.')
    await page.getByRole('button', { name: /^(滚动到底部|Scroll to bottom)$/ }).click()
    await expect.poll(async () => (await position()).gap).toBeLessThan(3)
    await page.mouse.click(scrollbar.x, bounds.y + bounds.height / 2)
    await expect.poll(async () => (await position()).gap).toBeGreaterThan(50)
    await settleScroll()
    const trackTop = (await position()).top
    await send({ ...common, type: 'model_delta', modelId: nextModel.id,
      delta: { type: 'reasoning', text: 'After scrollbar track click\n'.repeat(20) } })
    await expect(page.locator('.agent-activity-reasoning[open] pre')).toContainText('After scrollbar track click')
    await page.evaluate(() => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))))
    assert.ok((await position()).top <= trackTop + 2, 'A scrollbar track click must pause output following.')
    await page.getByRole('button', { name: /^(滚动到底部|Scroll to bottom)$/ }).click()
    await expect.poll(async () => (await position()).gap).toBeLessThan(3)
    await send({ ...common, type: 'model_completed', model: { ...nextModel, status: 'completed' } })
    // Earlier rows are unmounted while the reader is at the end of a long
    // reasoning body. Navigate to their viewport before inspecting them.
    await panel.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home')
    await reasoning.locator('summary').click()
    await expect(reasoning.locator('pre')).toHaveText(model.reasoning)
    await reasoning.locator('summary').click()
    await expect(reasoning.locator('pre')).toHaveCount(0)
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
    await summary.click()
    await expect(card.locator('pre')).toHaveCount(0)
    await expect(card.locator('.agent-activity-arguments')).toHaveCount(0)
    await summary.click()
    // The argument body can be reconstructed after its parent releases it.
    if (!await args.evaluate(element => element.open)) await args.locator('summary').click()
    await expect(args.locator('pre')).toHaveText(JSON.stringify(call.args, null, 2))
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'zh-CN', theme: 'dark' }))
    const sleepStarted = new Date(Date.now() - 5000).toISOString()
    const sleepCall = { id: 'sleep', name: 'sleep', args: { seconds: 15, summary: '等待新回复' } }
    await send({ ...common, type: 'tool_started', call: sleepCall, sequence: 5, startedAt: sleepStarted })
    const sleepCard = page.locator('.agent-activity-tool').filter({ has: page.locator('code').filter({ hasText: /^sleep$/ }) })
    const countdown = sleepCard.getByRole('timer')
    if ((await position()).gap > 2) await page.getByRole('button', { name: /^(滚动到底部|Scroll to bottom)$/ }).click()
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
    await panel.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home')
    await settleScroll()
    await page.locator('.agent-activity-process[open] > summary').click()
    const reviewed = { id: 'reviewed', name: 'pwsh', args: { command: 'echo keep-visible' } }
    const toolEvent = { ...common, call: reviewed, sequence: 6, startedAt: now }
    await send({ ...toolEvent, type: 'tool_approval_requested',
      approval: { status: 'pending_approval', interruptId: 'review', actionIndex: 0 } })
    const processSummary = page.locator('.agent-activity-process > summary')
    await expect(processSummary.locator('.lucide-shield-alert')).toBeVisible()
    await processSummary.click()
    // Reopening preserves the previously expanded large arguments. Verify
    // that restoration, then explicitly close them before inspecting the next tool.
    const restoredArguments = page.locator('.agent-activity-tool').filter({ hasText: 'apply_patch' }).locator('.agent-activity-arguments')
    await expect(restoredArguments.locator('pre')).toHaveText(JSON.stringify(call.args, null, 2))
    await restoredArguments.locator('summary').click()
    await expect(restoredArguments.locator('pre')).toHaveCount(0)
    await settleScroll()
    const reviewedCard = page.locator('.agent-activity-tool').filter({ hasText: 'pwsh' })
    if ((await position()).gap > 2) await page.getByRole('button', { name: /^(滚动到底部|Scroll to bottom)$/ }).click()
    await expect(reviewedCard.locator(':scope > summary .lucide-shield-alert')).toBeVisible()
    await reviewedCard.locator(':scope > summary').click()
    await reviewedCard.locator('.agent-activity-arguments > summary').click()
    const inspected = reviewedCard.locator('.agent-activity-arguments pre')
    await expect(inspected).toHaveText(JSON.stringify(reviewed.args, null, 2))
    await send({ ...toolEvent, type: 'tool_started' })
    await expect(reviewedCard.locator(':scope > summary .lucide-shield-alert')).toHaveCount(0)
    await expect(inspected).toBeVisible()
    await expect(inspected).toHaveText(JSON.stringify(reviewed.args, null, 2))
    await reviewedCard.locator(':scope > summary').click()
    await expect(reviewedCard).not.toHaveAttribute('open')
    await expect(inspected).toHaveCount(0)
    // Inspecting an attention item explicitly keeps its parent expanded;
    // closing that parent still releases the complete member subtree.
    await panel.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home')
    await settleScroll()
    await page.locator('.agent-activity-process[open] > summary').click()
    await expect(reviewedCard).toHaveCount(0)
    const waitCall = { id: 'wait', name: 'wait_call', args: { summary: '等待 Electron 非法 URL 测试结束' } }
    await send({ ...common, type: 'tool_started', call: waitCall, sequence: 7, startedAt: now })
    await expect(processSummary).toContainText('wait_call')
    await expect(processSummary).toContainText(waitCall.args.summary)
    await expect(page.locator('.agent-activity-process')).not.toHaveAttribute('open')
    if (process.env.ANAS_E2E_ACTIVITY_TITLE_SCREENSHOT) await processSummary.screenshot({ path: process.env.ANAS_E2E_ACTIVITY_TITLE_SCREENSHOT })
    const finalThought = { ...model, id: 'final-thought', round: 3, sequence: 8, reasoning: 'Next step\n'.repeat(160) }
    await send({ ...common, type: 'model_started', model: finalThought })
    await expect(processSummary).toHaveText('reasoning')
    if (process.env.ANAS_E2E_ACTIVITY_TITLE_SCREENSHOT) await processSummary.screenshot({ path: process.env.ANAS_E2E_ACTIVITY_TITLE_SCREENSHOT.replace(/\.png$/, '-reasoning.png') })
    await app.evaluate((_electron, common) => {
      for (let index = 0; index < 100; index++) globalThis.__sendToolArgumentEvent({ ...common, type: 'tool_completed', sequence: 9 + index,
        call: { id: `tail-${index}`, name: 'probe', args: {} }, output: 'done' })
    }, common)
    await processSummary.click()
    const thoughtRow = page.locator('[data-activity-item="model:root:final-thought"]')
    await expect(thoughtRow.locator('.agent-activity-reasoning[open] pre')).toHaveText(finalThought.reasoning)
    await settleScroll()
    await thoughtRow.evaluate(row => {
      const panel = row.closest('.agent-message-panel')
      panel.scrollTop += row.getBoundingClientRect().top - panel.getBoundingClientRect().top + 700
      panel.dispatchEvent(new Event('scroll'))
    })
    await settleScroll()
    const thoughtOffset = () => panel.evaluate(element => {
      const row = element.querySelector('[data-activity-item="model:root:final-thought"]')
      return row ? element.getBoundingClientRect().top - row.getBoundingClientRect().top : Infinity
    })
    assert.ok(Math.abs(await thoughtOffset() - 700) < 3, 'The reader must be inside the long body before it collapses.')
    await send({ ...common, type: 'model_completed', model: { ...finalThought, status: 'completed' } })
    await expect(thoughtRow.locator('.agent-activity-reasoning')).not.toHaveAttribute('open')
    await expect.poll(async () => Math.abs(await thoughtOffset())).toBeLessThan(3)
    const reply = { id: 'live-reply', round: 4, sequence: 1000, status: 'running', text: 'Reply begins before the run ends.', reasoning: '', toolCallIds: [] }
    await send({ ...common, type: 'model_started', model: reply })
    await expect(page.getByText(reply.text, { exact: true })).toBeVisible()
    await expect(page.locator('.agent-activity-process')).not.toHaveAttribute('open')
    await expect(page.locator('.agent-timeline-member')).toHaveCount(0)
    await expect(runStatus).toBeVisible()
    await processSummary.click()
    await expect(page.locator('.agent-activity-process')).toHaveAttribute('open')
    const beforeReplyDelta = await app.evaluate(() => globalThis.__toolArgumentDirectoryReads)
    await send({ ...common, type: 'model_delta', modelId: reply.id, delta: { type: 'text', text: ' More text.' } })
    await expect.poll(() => app.evaluate(() => globalThis.__toolArgumentDirectoryReads)).toBeGreaterThan(beforeReplyDelta)
    await settleScroll()
    await expect(page.locator('.agent-activity-process')).toHaveAttribute('open')
    console.log('Tool arguments E2E passed: reception, expansion lock, late IDs, lazy details, collapsed process groups and user-controlled output following.')
    console.log('Long reasoning completion keeps the paused reader on its collapsed row.')
    console.log('Sleep UI E2E passed: clock icon, countdown alignment, both themes and languages, completed duration.')
    console.log('Tool shimmer E2E passed: names, summaries, icons and countdown in one moving mask, reduced motion and completion cleanup.')
    console.log('Elapsed clock and reply folding passed: idle ticks do not reload data; a live reply closes its preceding process once and preserves manual reopening.')
  } finally {
    await app?.close()
    await rm(home, { recursive: true, force: true })
  }
}

module.exports = { verifyToolArguments }

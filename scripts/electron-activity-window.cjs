const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, dirname, basename } = require('node:path')
const { expect } = require('playwright/test')
const { monacoState } = require('./electron-diff-view.cjs')

async function verifyActivityWindow(launchApplication, { positionOnly = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'anas-activity-directory-'))
  if (dirname(home) !== tmpdir() || !basename(home).startsWith('anas-activity-directory-')) throw new Error('Unexpected test directory')
  let app
  try {
    app = await launchApplication(home)
    const page = await app.firstWindow(), errors = []
    page.on('pageerror', error => errors.push(String(error)))
    const settle = () => page.evaluate(() => new Promise(resolve => {
      const panel = globalThis.document.querySelector('.agent-message-panel')
      let previous = panel.scrollTop, stable = 0, frames = 0
      const check = () => {
        const top = panel.scrollTop
        stable = Math.abs(top - previous) < 0.5 ? stable + 1 : 0
        previous = top
        if (stable >= 6 || ++frames >= 180) resolve()
        else globalThis.requestAnimationFrame(check)
      }
      globalThis.requestAnimationFrame(check)
    }))
    await page.locator('[data-agent-composer-input]').waitFor()
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const now = new Date().toISOString(), threadId = 'activity-thread', runId = 'activity-run'
      const thread = { id: threadId, projectId: 'default-workspace', title: 'Activity directory probe', status: 'idle',
        accessMode: 'smart_approval', pinned: false, userTurnCount: 1, createdAt: now, updatedAt: now }
      const run = { runId, operation: 'agent', status: 'completed', createdAt: now, updatedAt: now, models: [], tools: [], subagents: [],
        display: { modelCount: 900, toolCount: 10000, subagentCount: 0, finalMessageId: 'final' } }
      const snapshot = { thread, messages: [
        { id: 'user', role: 'user', runId, content: [{ type: 'text', text: 'DIRECTORY_QUESTION' }] },
        { id: 'final', role: 'assistant', runId, activityModelId: 'final-model', content: [{ type: 'text', text: 'DIRECTORY_ANSWER' }] }
      ], activities: [run], todos: [], interrupts: [], messageWindow: { startIndex: 0, shown: 2, total: 2, remaining: 0 } }
      const tool = index => {
        const key = `tool:${index}`, position = { sequence: index, part: 1, key }
        return { type: 'entry', key, start: position, end: position, position,
          item: { type: 'tool', key, tool: { sequence: index, status: 'completed',
            call: { id: String(index), name: 'pwsh', args: { summary: `TOOL_ROW_${index}` } },
            detail: { threadId, runId, kind: 'tool', id: String(index) } } } }
      }
      const group = { type: 'process', key: 'process:tool:0', start: tool(0).start, end: tool(9999).end,
        first: tool(0).item, hasThought: false, hasTools: true }
      const replies = Array.from({ length: 899 }, (_, index) => {
        const key = `reply:${index + 1}`, position = { sequence: 10000 + index, part: 2, key }
        return { type: 'reply', key, start: position, end: position, position,
          model: { id: key, sequence: position.sequence, status: 'completed', text: `REPLY_${index + 1}`, reasoning: '', toolCallIds: [] } }
      })
      globalThis.__activityStatus = 'completed'
      globalThis.__activityRevision = 0
      globalThis.__directoryRevision = 0
      globalThis.__activityReads = 0
      globalThis.__activityDetails = 0
      globalThis.__appendActivity = () => {
        const index = replies.length + 1, key = `reply:${index}`, position = { sequence: 9999 + index, part: 2, key }
        const model = { id: key, sequence: position.sequence, status: 'running', text: `REPLY_${index}`, reasoning: '', toolCallIds: [],
          detail: { threadId, runId, kind: 'model', id: key } }
        replies.push({ type: 'reply', key, start: position, end: position, position, model })
        globalThis.__directoryRevision++
        BrowserWindow.getAllWindows()[0].webContents.send('agent:event', { revision: ++globalThis.__activityRevision, replayActive: true,
          event: { type: 'model_started', threadId, runId, model } })
      }
      globalThis.__streamActivity = async () => {
        const model = replies.at(-1).model
        for (let index = 0; index < 250; index++) {
          model.text += '.'
          BrowserWindow.getAllWindows()[0].webContents.send('agent:event', { revision: ++globalThis.__activityRevision, replayActive: true,
            event: { type: 'model_delta', threadId, runId, modelId: model.id, delta: { type: 'text', text: '', hasText: true } } })
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        return model.text
      }
      for (const [channel, handler] of [
        ['agent:threads:list', () => [thread]], ['agent:threads:get', () => ({ ...snapshot,
          messages: globalThis.__activityStatus === 'running' ? snapshot.messages.slice(0, 1) : snapshot.messages,
          activities: [{ ...run, status: globalThis.__activityStatus }] })],
        ['agent:workspace:get', () => ({ mode: 'thread', threadId })], ['agent:runs:recover', () => false],
        ['agent:events:subscribe', () => ({ revision: globalThis.__activityRevision, replay: [], replayComplete: true })],
        ['agent:activities:directory', async (_event, input) => {
          if (input.threadId !== threadId || input.runId !== runId) throw new Error('Wrong fixture scope')
          globalThis.__activityReads++
          const version = String(globalThis.__directoryRevision)
          const items = input.version === version ? [] : input.parentId ? Array.from({ length: 10000 }, (_, index) => tool(index)) : [group, ...replies]
          if (globalThis.__activityGate) await globalThis.__activityGate
          return { version, ...(input.version === version ? { baseVersion: version } : {}), items, removed: [] }
        }],
        ['agent:activities:cancel', () => {}],
        ['agent:activities:detail', (_event, input) => {
          globalThis.__activityDetails++
          if (input.kind === 'model') return { text: replies.find(item => item.model.id === input.id).model.text }
          return { args: { command: `echo ${input.id}` }, output: `BODY_START_${input.id}\n` + 'Tool result line.\n'.repeat(20000) + `BODY_END_${input.id}` }
        }]
      ]) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
    })
    await page.reload()
    await expect(page.getByText('DIRECTORY_ANSWER')).toBeVisible()
    const panel = page.locator('.agent-message-panel')
    const range = page.locator('.agent-activity-range-toggle[aria-expanded]')
    const group = page.locator('.agent-activity-process')
    await expect(range).toHaveAttribute('aria-expanded', 'false')
    assert.equal(await app.evaluate(() => globalThis.__activityReads), 0)
    await range.click()
    await expect(group).toBeVisible()
    assert.equal(await app.evaluate(() => globalThis.__activityReads), 1)
    await group.locator('summary').click()
    await expect(page.getByText('TOOL_ROW_0', { exact: true })).toBeVisible()
    assert.equal(await app.evaluate(() => globalThis.__activityReads), 2, 'Opening a group reads only that group')
    assert.equal(await app.evaluate(() => globalThis.__activityDetails), 0)
    assert.ok(await page.locator('[data-timeline-row]').count() < 150, 'Only viewport rows mount')
    if (!positionOnly) {
      const first = page.locator('[data-activity-item="tool:0"]')
      await first.locator('.agent-activity-tool > summary').click()
      await first.locator('.agent-activity-result > summary').click()
      await expect(first.locator('.monaco-editor')).toBeVisible()
      await first.locator('.view-lines').click()
      await page.keyboard.press('Control+End')
      await expect(first.locator('.view-lines')).toContainText('BODY_END_0')
      // Virtualization releases bodies, but returning to an inspected tool must
      // restore its disclosures rather than losing the reader's choices.
      await panel.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll', { bubbles: true })) })
      await expect(first).toHaveCount(0)
      await expect.poll(async () => (await monacoState(app, page)).models.length).toBe(0)
      await panel.evaluate(element => { element.dispatchEvent(new globalThis.WheelEvent('wheel', { deltaY: -1, bubbles: true })); element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true })) })
      await expect(first.locator('.agent-activity-tool')).toHaveAttribute('open', '')
      await expect(first.locator('.agent-activity-result')).toHaveAttribute('open', '')
      await expect(first.locator('.monaco-editor')).toBeVisible()
      await first.locator('.agent-activity-tool > summary').evaluate(element => element.click())
      await expect.poll(async () => (await monacoState(app, page)).models.length).toBe(0)
    }
    await panel.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll', { bubbles: true })) })
    await expect(page.getByText('DIRECTORY_ANSWER')).toBeVisible()
    await expect(page.getByText('REPLY_899', { exact: true })).toBeVisible()
    assert.ok(await page.locator('[data-timeline-row]').count() < 150)
    await panel.evaluate(element => { element.dispatchEvent(new globalThis.WheelEvent('wheel', { deltaY: -1, bubbles: true })); element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true })) })
    await expect(page.getByText('TOOL_ROW_0', { exact: true })).toBeVisible()
    await group.locator('summary').click()
    await expect(page.locator('.agent-timeline-member')).toHaveCount(0)
    assert.equal(await app.evaluate(() => globalThis.__activityReads), 2, 'Scrolling and folding never read directory pages')

    await app.evaluate(() => { globalThis.__activityStatus = 'running' })
    await page.reload()
    await expect(page.getByText('REPLY_899', { exact: true })).toBeVisible()
    await app.evaluate(() => globalThis.__appendActivity())
    await expect(page.getByText('REPLY_900', { exact: true })).toBeVisible()
    const box = await panel.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -800)
    await settle()
    const anchor = await panel.evaluate(element => {
      const top = element.getBoundingClientRect().top
      const row = [...element.querySelectorAll('[data-timeline-row]')].find(item => item.getBoundingClientRect().top >= top)
      return { key: row.dataset.timelineRow, top: row.getBoundingClientRect().top }
    })
    const anchorRow = page.locator(`[data-timeline-row="${anchor.key}"]`)
    const reads = await app.evaluate(() => globalThis.__activityReads)
    await app.evaluate(() => { globalThis.__activityGate = new Promise(resolve => { globalThis.__releaseActivity = resolve }); globalThis.__appendActivity() })
    await expect.poll(() => app.evaluate(() => globalThis.__activityReads)).toBeGreaterThan(reads)
    await panel.evaluate(element => { element.style.display = 'none' })
    await app.evaluate(() => { globalThis.__releaseActivity(); globalThis.__activityGate = undefined })
    await settle()
    await panel.evaluate(element => { element.style.display = '' })
    await expect.poll(async () => Math.abs((await anchorRow.boundingBox()).y - anchor.top)).toBeLessThan(3)
    await app.evaluate(() => { for (let index = 0; index < 10; index++) globalThis.__appendActivity() })
    await settle()
    await expect.poll(async () => Math.abs((await anchorRow.boundingBox()).y - anchor.top)).toBeLessThan(3)
    await page.getByRole('button', { name: /^(滚动到底部|Scroll to bottom)$/ }).click()
    await expect(page.getByText('REPLY_911', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /加载后续活动|Load later activities|回到最新活动|Back to latest activity/ })).toHaveCount(0)
    if (!positionOnly) {
      // Keep the full 10000-member group expanded while output continues. This
      // exercises real IPC, React and Chromium scheduling, not a DOM-only limit.
      await panel.focus(); await page.keyboard.press('Control+Home'); await settle()
      await group.locator('summary').click()
      await page.getByRole('button', { name: /^(滚动到底部|Scroll to bottom)$/ }).click()
      await settle()
      const cdp = await page.context().newCDPSession(page)
      const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize }
      const heaps = [await heap()], frameGaps = [], interactions = []
      try {
        for (let batch = 0; batch < 3; batch++) {
          await page.evaluate(() => {
            const probe = globalThis.__activityFrames = { gaps: [], running: true, last: performance.now() }
            const frame = now => { probe.gaps.push(now - probe.last); probe.last = now; if (probe.running) globalThis.requestAnimationFrame(frame) }
            globalThis.requestAnimationFrame(frame)
          })
          const pumping = app.evaluate(() => globalThis.__streamActivity())
          const started = performance.now(), composer = page.locator('[data-agent-composer-input]')
          await composer.fill(`Draft survives streaming ${batch}`)
          await expect(composer).toHaveValue(`Draft survives streaming ${batch}`)
          interactions.push(performance.now() - started)
          const body = await pumping
          await expect(page.locator('[data-activity-item="reply:911"]')).toHaveText(body)
          frameGaps.push(...await page.evaluate(() => { globalThis.__activityFrames.running = false; return globalThis.__activityFrames.gaps }))
          assert.ok(await page.locator('[data-timeline-row]').count() < 150)
          heaps.push(await heap())
        }
        frameGaps.sort((a, b) => a - b)
        const p95 = frameGaps[Math.floor(frameGaps.length * 0.95)], max = frameGaps.at(-1)
        assert.ok(p95 < 80 && max < 500, `Streaming blocks frames: p95=${p95}, max=${max}`)
        assert.ok(Math.max(...interactions) < 1000, `Composer is unresponsive: ${interactions}`)
        assert.ok(heaps.at(-1) - heaps[0] < 32 * 1024 * 1024, `Repeated streaming retains excessive heap: ${heaps}`)
        console.log('Activity streaming pressure:', JSON.stringify({ events: 750, frameP95Ms: p95, frameMaxMs: max,
          interactionMs: interactions, rendererHeapMiB: heaps.map(value => Math.round(value / 1024 / 1024)) }))
      } finally { await cdp.detach() }
    }
    assert.deepEqual(errors, [])
    console.log('Activity directory: scoped outline and group reads, 10000 members, bounded mounted rows, lazy detail release, follow/pause and hidden-panel anchoring passed.')
  } finally {
    if (app) await app.close()
    await rm(home, { recursive: true, force: true })
  }
}
module.exports = { verifyActivityWindow }

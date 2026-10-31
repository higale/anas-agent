const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, dirname, basename } = require('node:path')
const { expect } = require('playwright/test')
const { monacoState } = require('./electron-diff-view.cjs')

async function verifyActivityWindow(launchApplication, { positionOnly = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'anas-activity-window-'))
  if (dirname(home) !== tmpdir() || !basename(home).startsWith('anas-activity-window-')) throw new Error('Unexpected test directory')
  let app
  try {
    app = await launchApplication(home)
    const page = await app.firstWindow()
    await page.locator('[data-agent-composer-input]').waitFor()
    await app.evaluate(({ ipcMain }) => {
      const now = new Date().toISOString(), threadId = 'activity-thread', runId = 'activity-run'
      const thread = { id: threadId, projectId: 'default-workspace', title: 'Activity window probe', status: 'idle',
        accessMode: 'smart_approval', pinned: false, userTurnCount: 1, createdAt: now, updatedAt: now }
      const run = { runId, operation: 'agent', status: 'completed', createdAt: now, updatedAt: now, models: [], tools: [], subagents: [],
        display: { modelCount: 1, toolCount: 900, subagentCount: 0, finalMessageId: 'final' } }
      const snapshot = { thread, messages: [
        { id: 'user', role: 'user', runId, content: [{ type: 'text', text: 'ACTIVITY_WINDOW_QUESTION' }] },
        { id: 'final', role: 'assistant', runId, content: [{ type: 'text', text: 'ACTIVITY_WINDOW_ANSWER\n\n' + 'Content after this activity.\n\n'.repeat(25) }] }
      ], activities: [run], todos: [], interrupts: [], messageWindow: { startIndex: 0, shown: 2, total: 2, remaining: 0 } }
      globalThis.__activityStatus = 'completed'
      globalThis.__activityWindowReads = []
      globalThis.__activityDetailReads = 0
      for (const [channel, handler] of [
        ['agent:threads:list', () => [thread]], ['agent:threads:get', () => ({ ...snapshot, messages: globalThis.__activityStatus === 'running' ? snapshot.messages.slice(0, 1) : snapshot.messages, activities: [{ ...run, status: globalThis.__activityStatus }] })],
        ['agent:workspace:get', () => ({ mode: 'thread', threadId })],
        ['agent:runs:recover', () => false],
        ['agent:events:subscribe', () => ({ revision: 0, replay: [], replayComplete: true })],
        ['agent:activities:page', async (_event, input) => {
          assertScope(input)
          globalThis.__activityWindowReads.push(input)
          if (globalThis.__activityPageGate) await globalThis.__activityPageGate
          const limit = input.limit ?? 300
          const end = input.before ?? (input.after === undefined ? 900 : Math.min(900, input.after + 1 + limit))
          const start = input.after === undefined ? Math.max(0, end - limit) : input.after + 1
          return { ...run, status: globalThis.__activityStatus, activityWindow: { startSequence: start, endSequence: end - 1, totalCount: 900, hasEarlier: start > 0, hasLater: end < 900 },
            tools: Array.from({ length: end - start }, (_, index) => ({ sequence: start + index, status: 'completed',
              call: { id: String(start + index), name: 'pwsh', args: { summary: `WINDOW_ROW_${start + index}` } },
              detail: { threadId, runId, kind: 'tool', id: String(start + index) } })) }
        }],
        ['agent:activities:detail', (_event, input) => {
          assertScope(input); globalThis.__activityDetailReads++
          return { [input.field]: input.field === 'args' ? { command: `echo ${input.id}` }
            : `BODY_START_${input.id}\n` + 'Large tool result line with retained display evidence.\n'.repeat(200000) + `BODY_END_${input.id}` }
        }]
      ]) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
      function assertScope(input) { if (input.threadId !== threadId || input.runId !== runId) throw new Error('Wrong activity fixture scope') }
    })
    await page.reload()
    await expect(page.getByText('ACTIVITY_WINDOW_ANSWER')).toBeVisible()
    const range = page.locator('.agent-activity-range')
    await expect(range).toHaveClass(/collapsed/)
    await expect(page.locator('.agent-activity-window')).toHaveCount(0)
    assert.equal(await app.evaluate(() => globalThis.__activityWindowReads.length), 0)
    await range.locator('.agent-activity-range-toggle').first().click()
    await expect(range.locator('.agent-activity-tool')).toHaveCount(300)
    await page.evaluate(() => new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))))
    assert.equal(await app.evaluate(() => globalThis.__activityWindowReads.length), 1, 'Expansion must read the initial page only once.')
    await expect(range.locator('.agent-activity-range-toggle').first()).toBeInViewport()
    assert.equal(await app.evaluate(() => globalThis.__activityDetailReads), 0, 'Collapsed entries must not read bodies.')
    await expect(range.getByText('WINDOW_ROW_0', { exact: true })).toBeInViewport()
    await expect(range.getByText('WINDOW_ROW_899', { exact: true })).toHaveCount(0)
    const later = range.getByRole('button', { name: /^(加载后续活动|Load later activities)$/ })
    for (let index = 0; index < 4; index++) {
      const reads = await app.evaluate(() => globalThis.__activityWindowReads.length)
      await later.scrollIntoViewIfNeeded()
      await expect.poll(() => app.evaluate(() => globalThis.__activityWindowReads.length)).toBeGreaterThan(reads)
      await expect.poll(() => range.locator('.agent-activity-tool').count()).toBeLessThanOrEqual(500)
    }
    const first = range.locator('[data-activity-page="0"]')
    await expect(first.locator('.agent-activity-tool')).toHaveCount(0)
    await first.scrollIntoViewIfNeeded()
    await expect(first.locator('.agent-activity-tool')).toHaveCount(100)
    await expect(range.locator('.agent-activity-tool')).toHaveCount(500)
    // Exercise this command without Playwright scrolling through the paging
    // boundary first: that scroll can load the remaining pages and remove it.
    await range.getByRole('button', { name: /^(回到最新活动|Back to latest activity)$/ }).evaluate(button => button.click())
    const bottom = range.locator('[data-activity-page="800"]')
    await expect(bottom.locator('.agent-activity-tool')).toHaveCount(100)
    await expect(range.locator('.agent-activity-tool')).toHaveCount(300)
    await expect(range.getByText('WINDOW_ROW_899', { exact: true })).toBeInViewport()
    await expect(page.getByText('ACTIVITY_WINDOW_ANSWER', { exact: true })).not.toBeInViewport()
    if (positionOnly) {
      const panel = page.locator('.workspace-content-scroll')
      await page.locator('.scroll-boundary-button-top').click()
      await expect(range.getByText('WINDOW_ROW_0', { exact: true })).toBeInViewport()
      await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBe(0)
      await app.evaluate(() => { globalThis.__activityPageGate = new Promise(resolve => { globalThis.__releaseActivityPage = resolve }) })
      await page.locator('.scroll-boundary-button-bottom').click()
      await expect(range.locator('.agent-activity-window > [role="status"]')).toBeVisible()
      await page.evaluate(() => new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)))))
      assert.equal(await panel.evaluate(element => element.scrollTop), 0, 'Loading the tail must not enable follow-output and scroll the old window.')
      await app.evaluate(() => { globalThis.__releaseActivityPage(); globalThis.__activityPageGate = undefined })
      await expect(range.getByText('WINDOW_ROW_899', { exact: true })).toHaveCount(1)
      await expect.poll(() => panel.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
      // Return from the final answer to the first activity without walking
      // backwards through every evicted page.
      await panel.hover()
      await page.mouse.wheel(0, -100)
      await page.locator('.scroll-boundary-button-top').click()
      await expect(range.getByText('WINDOW_ROW_0', { exact: true })).toBeInViewport()
      await range.locator('.agent-activity-range-toggle').first().click()
      await range.locator('.agent-activity-range-toggle').first().click()
      await expect(range.getByText('WINDOW_ROW_0', { exact: true })).toBeInViewport()
      await app.evaluate(() => { globalThis.__activityStatus = 'running'; globalThis.__activityWindowReads = [] })
      await page.reload()
      await expect(range.getByText('WINDOW_ROW_899', { exact: true })).toBeInViewport()
      await expect(range.locator('.agent-activity-range-toggle')).toHaveCount(0)
      await expect(range.locator('.agent-activity-tool')).toHaveCount(300)
      assert.equal(await app.evaluate(() => globalThis.__activityWindowReads.length), 1)
      await panel.hover()
      await page.mouse.wheel(0, -100)
      await page.locator('.scroll-boundary-button-top').click()
      await expect(range.getByText('WINDOW_ROW_0', { exact: true })).toBeInViewport()
      await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBe(0)
      assert.equal((await app.evaluate(() => globalThis.__activityWindowReads.at(-1))).after, -1)
      console.log('Activity position E2E passed: first/tail entry, bidirectional eviction/restoration, local latest, and delayed sidebar navigation positions only after the boundary page is ready.')
      return
    }
    const tool = bottom.locator('.agent-activity-tool').last()
    await tool.locator(':scope > summary').click()
    const result = tool.locator('.agent-activity-result')
    const cdp = await page.context().newCDPSession(page)
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize }
    const before = await heap()
    const openedAt = Date.now()
    await result.locator(':scope > summary').click()
    await expect(result.locator('.monaco-editor')).toBeVisible()
    await expect(result.locator('.view-lines')).toContainText('BODY_START_899')
    await result.locator('.view-lines').click()
    await page.keyboard.press('Control+End')
    await expect(result.locator('.view-lines')).toContainText('BODY_END_899')
    const openedMs = Date.now() - openedAt
    const loaded = await heap()
    await result.locator(':scope > summary').click()
    await expect(result.locator('.monaco-editor')).toHaveCount(0)
    assert.equal((await monacoState(app, page)).models.length, 0, 'Collapsing the result must dispose its text model.')
    await range.locator('.agent-activity-range-toggle').first().click()
    await expect(range.locator('.agent-activity-window')).toHaveCount(0)
    const released = await heap()
    assert.ok(loaded - released > 5 * 1024 * 1024, `Large detail should be collectible: before=${before}, loaded=${loaded}, released=${released}`)
    await range.locator('.agent-activity-range-toggle').first().click()
    await expect(range.locator('.agent-activity-tool')).toHaveCount(300)
    console.log(`Activity windows E2E passed: bidirectional reads, 500-entry bound, collapsed bodies not fetched, whole-run unmount. Large detail opened and reached its end in ${openedMs}ms. Heap bytes: baseline=${before}, loaded=${loaded}, released=${released}.`)
  } finally { await app?.close(); await rm(home, { recursive: true, force: true }) }
}
module.exports = { verifyActivityWindow }

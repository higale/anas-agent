const assert = require('node:assert/strict')
const { mkdir, mkdtemp, rm, symlink, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, dirname, join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')

// Test-only wrapper exposes the actual built module's storage objects. All
// renderer reads keep their real preload/IPC/runtime/database implementations.
async function verifyCurrentStorage(repositoryRoot, executablePath) {
  const root = await mkdtemp(join(tmpdir(), 'anas-current-storage-e2e-'))
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('anas-current-storage-e2e-')) throw new Error('Unexpected storage test directory.')
  const count = Number(process.env.ANAS_E2E_STORAGE_MESSAGES || 1000)
  assert.ok(Number.isSafeInteger(count) && count >= 1000 && count <= 10000)
  let application
  let phase = 'launch'
  try {
    const documents = join(root, 'documents')
    await mkdir(documents)
    await symlink(join(repositoryRoot, 'data'), join(root, 'data'), 'junction')
    await symlink(join(repositoryRoot, 'out'), join(root, 'out'), 'junction')
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'anas-current-storage-test', version: '1.0.0', main: 'main.cjs' }))
    await writeFile(join(root, 'main.cjs'), `
      const { app, ipcMain } = require('electron')
      const Module = require('node:module')
      const nativeRequire = Module.createRequire(${JSON.stringify(join(repositoryRoot, 'package.json'))})
      app.setPath('documents', ${JSON.stringify(documents)})
      const compiledRoot = ${JSON.stringify(join(repositoryRoot, 'out', 'main'))}
      const originalCompile = Module.prototype._compile
      Module.prototype._compile = function(content, filename) {
        if (filename.startsWith(compiledRoot) && content.includes('function currentStorage()')) {
          content += '\\n;globalThis.__anasStorageAccess = { currentStorage, currentRuntime };'
        }
        return originalCompile.call(this, content, filename)
      }
      globalThis.__anasStorageProbe = { snapshots: [], activityPages: [], nativeRequire }
      const originalHandle = ipcMain.handle.bind(ipcMain)
      ipcMain.handle = (channel, handler) => originalHandle(channel, async (...args) => {
        const started = performance.now()
        try {
          const value = await handler(...args)
          if (channel === 'agent:activities:page') globalThis.__anasStorageProbe.activityPages.push({
            beforeSequence: args[1].before, limit: args[1].limit, startSequence: value.activityWindow.startSequence,
            count: value.models.length + value.tools.length + value.subagents.length + (value.summaries?.length || 0) + (value.memoryRecalls?.length || 0)
          })
          return value
        }
        finally {
          if (channel === 'agent:threads:get') globalThis.__anasStorageProbe.snapshots.push(performance.now() - started)
        }
      })
      require(${JSON.stringify(join(repositoryRoot, 'out', 'main', 'index.js'))})
      Module.prototype._compile = originalCompile
    `)
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.ELECTRON_RENDERER_URL
    application = await electron.launch({
      executablePath,
      args: [root, '--data-dir', join(root, 'profile'), ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [])],
      cwd: repositoryRoot, env: environment, timeout: 45000
    })
    application.process().stderr.on('data', (chunk) => {
      if (/Error|error|failed/i.test(String(chunk))) console.error(String(chunk).trim())
    })
    const page = await application.firstWindow({ timeout: 45000 })
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await expect(page.locator('[data-agent-composer-input]')).toBeVisible({ timeout: 15000 })
    phase = 'seed complete native messages'
    const seeded = await application.evaluate(async (_electron, count) => {
      const { currentStorage, currentRuntime } = globalThis.__anasStorageAccess || {}
      if (!currentStorage) throw new Error('The built main module did not expose current storage; rebuild the current tree.')
      const probe = globalThis.__anasStorageProbe
      const { randomUUID } = probe.nativeRequire('node:crypto')
      const storage = currentStorage()
      const started = performance.now()
      const threads = []
      const runs = []
      for (const [title, length] of [['Storage long conversation', count], ['Storage short conversation', 2]]) {
        const thread = storage.createThread({ title })
        const database = storage.conversationForThread(thread.id)
        const runId = randomUUID()
        const messages = Array.from({ length }, (_, index) => {
          const id = index === 0 ? runId + ':input' : thread.id + ':seed:' + index
          return { id, value: { id, kind: index % 2 ? 'assistant' : 'user',
            content: 'Storage fixture ' + index + '. ' + 'x'.repeat(768), context: { runId } } }
        })
        const run = database.runs.createRun({ threadId: thread.id, runId, operation: 'agent', message: messages[0] })
        const store = database.runs.store
        const revisionId = store.start({ threadId: thread.id, runId, expectedRevisionId: store.readHistory(thread.id).revisionId,
          messages, context: { modelCalls: length / 2, todos: [] } })
        if (length === count) {
          // A controlled executor owns the live run while the benchmark writes
          // native model commits. Real UI recovery sees this same owner;
          // no model provider or second execution is started by snapshot reads.
          const host = currentRuntime().runtimeForDatabase(database)
          let ready
          const started = new Promise(resolve => { ready = resolve })
          probe.handle = host.start({ threadId: thread.id, runId }, 'continue', async ({ signal }) => ({
            dispose: async () => {}, execution: { execute: async () => {
              await new Promise(resolve => {
                probe.releaseExecution = resolve
                signal.addEventListener('abort', resolve, { once: true })
                if (signal.aborted) resolve()
                ready()
              })
              return { result: { status: 'fulfilled', value: undefined }, interrupted: false, observationErrors: [] }
            } }
          }))
          await started
        } else store.finish({ threadId: thread.id, runId, expectedRevisionId: revisionId }, 'completed')
        storage.refreshConversation(thread.id)
        threads.push(thread.id)
        runs.push(run)
      }
      probe.threads = threads
      probe.runs = runs
      return { threads, seedMs: performance.now() - started }
    }, count)
    phase = 'load real conversation snapshot'
    await page.reload()
    const longThread = page.locator('.thread-open').filter({ hasText: 'Storage long conversation' })
    const shortThread = page.locator('.thread-open').filter({ hasText: 'Storage short conversation' })
    await expect(longThread).toBeVisible()
    await longThread.click()
    await expect(page.locator('.topbar')).toContainText('Storage long conversation')
    const initialSnapshot = await page.evaluate((id) => globalThis.gale.agent.threads.get(id), seeded.threads[0])
    assert.equal(initialSnapshot.messageWindow.total, count)
    assert.ok(initialSnapshot.messages.length < count, 'The UI snapshot must page the real database, not load the entire conversation.')
    const initialActivity = initialSnapshot.activities[0]
    assert.ok(initialActivity.activityWindow.hasEarlier)
    assert.equal(initialActivity.models.length, 0, 'The collapsed summary must not retain completed model records.')
    assert.equal(initialActivity.display.modelCount, count / 2)
    const expandActivities = async () => {
      const toggle = page.locator('.agent-activity-range-toggle[aria-expanded="false"]').first()
      if (await toggle.count()) await toggle.click()
    }
    await expandActivities()
    await expect.poll(() => page.locator('.agent-activity-model').count()).toBeGreaterThan(0)
    const initialVisibleActivities = await page.locator('.agent-activity-model').count()
    await page.getByRole('button', { name: /^(加载更早活动|Load earlier activities)$/ }).click()
    await expect.poll(() => page.locator('.agent-activity-model').count()).toBeGreaterThan(initialVisibleActivities)
    const pages = await application.evaluate(() => globalThis.__anasStorageProbe.activityPages)
    assert.ok(pages.some(item => item.limit === 300), 'Expanding must read a bounded latest page through real IPC.')
    const earlierPage = pages.find(item => item.beforeSequence !== undefined)
    assert.equal(earlierPage.count, 100)
    assert.ok(earlierPage.startSequence < earlierPage.beforeSequence)

    await page.evaluate(() => {
      const probe = globalThis.__anasStorageFrames = { gaps: [], last: performance.now(), running: true }
      const frame = (now) => { probe.gaps.push(now - probe.last); probe.last = now; if (probe.running) globalThis.requestAnimationFrame(frame) }
      globalThis.requestAnimationFrame(frame)
    })
    await application.evaluate(() => {
      const probe = globalThis.__anasStorageProbe
      const { currentStorage } = globalThis.__anasStorageAccess
      const { randomUUID } = probe.nativeRequire('node:crypto')
      probe.stop = false
      probe.completed = false
      probe.appendMs = []
      probe.delays = []
      probe.snapshots = []
      let last = performance.now()
      const monitor = setInterval(() => { const now = performance.now(); probe.delays.push(Math.max(0, now - last - 10)); last = now }, 10)
      probe.job = (async () => {
        const database = currentStorage().conversationForThread(probe.threads[0])
        const run = probe.runs[0], store = database.runs.store
        let revisionId
        const scope = () => ({ threadId: run.threadId, runId: run.id, expectedRevisionId: revisionId })
        try {
          const started = performance.now()
          const history = store.readHistory(run.threadId)
          revisionId = history.revisionId
          probe.hydrateMs = performance.now() - started
          for (let index = 0; index < 500 && (!probe.stop || index < 10); index += 1) {
            const appendStarted = performance.now(), id = randomUUID()
            const context = { modelCalls: history.context.modelCalls + index + 1, todos: [] }
            revisionId = store.acceptModel(scope(), { id, value: { id, kind: 'assistant', content: 'Live complete result ' + index + '. ' + 'y'.repeat(2048),
              context: { runId: run.id } } }, [], context)
            revisionId = store.continueAfterModel(scope(), [], context)
            probe.appendMs.push(performance.now() - appendStarted)
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          store.finish(scope(), 'completed')
          probe.finalCount = store.readHistory(run.threadId).messages.length
        } catch (error) { probe.error = String(error); throw error }
        finally {
          probe.releaseExecution()
          await probe.handle.drained
          clearInterval(monitor)
          probe.completed = true
        }
      })()
      probe.job.catch(() => undefined)
    })

    phase = 'interact during current state writes'
    const interactionMs = []
    for (const [width, height] of [[1120, 820], [1380, 950]]) {
      const writing = await application.evaluate(() => ({ completed: globalThis.__anasStorageProbe.completed, error: globalThis.__anasStorageProbe.error }))
      assert.equal(writing.error, undefined, 'The native persistence workload must not fail.')
      assert.equal(writing.completed, false, 'Storage writes must still be active during interactions.')
      const started = performance.now()
      await application.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.unmaximize(); window.setContentSize(...size) }, [width, height])
      await expect.poll(() => page.evaluate(() => Math.round(globalThis.document.querySelector('.app-shell').getBoundingClientRect().width)), { timeout: 3000 }).toBe(width)
      await expect.poll(() => page.evaluate(() => Math.round(globalThis.document.querySelector('.app-shell').getBoundingClientRect().height)), { timeout: 3000 }).toBe(height)
      await page.locator('.sidebar-collapse').click()
      await expect(page.locator('.app-shell')).toHaveClass(/sidebar-collapsed/)
      await page.locator('.topbar-sidebar-toggle').click()
      await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/)
      await shortThread.click()
      await expect(page.locator('.topbar')).toContainText('Storage short conversation')
      await expect(page.locator('.message-sequence')).toHaveCount(2)
      await longThread.click()
      await expect(page.locator('.topbar')).toContainText('Storage long conversation')
      await expandActivities()
      await expect.poll(() => page.locator('.agent-activity-model').count()).toBeGreaterThan(0)
      assert.ok(await page.locator('.agent-activity-model').count() <= 500, 'Reopening must not accumulate prior activity pages.')
      const snapshot = await page.evaluate((id) => globalThis.gale.agent.threads.get(id), seeded.threads[0])
      assert.ok(snapshot.messageWindow.total > count)
      assert.ok(snapshot.messages.length < count)
      interactionMs.push(performance.now() - started)
    }
    await application.evaluate(async () => { globalThis.__anasStorageProbe.stop = true; await globalThis.__anasStorageProbe.job })
    const result = await application.evaluate(() => {
      const probe = globalThis.__anasStorageProbe
      const max = (values) => Math.max(0, ...values)
      return { hydrateMs: probe.hydrateMs, appendCount: probe.appendMs.length, appendMaxMs: max(probe.appendMs),
        mainDelayMaxMs: max(probe.delays), snapshotMaxMs: max(probe.snapshots), finalCount: probe.finalCount,
        activityPages: probe.activityPages, error: probe.error }
    })
    const frameMaxMs = await page.evaluate(() => { const probe = globalThis.__anasStorageFrames; probe.running = false; return Math.max(0, ...probe.gaps) })
    console.log('Native storage timings:', JSON.stringify({ ...result, frameMaxMs, interactionMs }))
    assert.equal(result.error, undefined)
    assert.equal(result.finalCount, count + result.appendCount)
    assert.ok(result.appendCount >= 10)
    assert.ok(result.mainDelayMaxMs < 500, `Main process blocked for ${result.mainDelayMaxMs.toFixed(1)} ms.`)
    assert.ok(result.snapshotMaxMs < 1500, `Real snapshot IPC took ${result.snapshotMaxMs.toFixed(1)} ms.`)
    assert.ok(frameMaxMs < 1500, `Renderer frame stalled for ${frameMaxMs.toFixed(1)} ms.`)
    assert.deepEqual(pageErrors, [])
    await expect(page.locator('.thread-title.error, .agent-activity-error')).toHaveCount(0)
    await page.screenshot({ path: process.env.ANAS_E2E_STORAGE_SCREENSHOT || join(tmpdir(), 'anas-current-storage.png') })
    phase = 'delete missing and damaged conversations through real IPC'
    for (const kind of ['missing', 'corrupt', 'unsupported version']) {
      const lost = await application.evaluate((_electron, kind) => {
        const storage = globalThis.__anasStorageAccess.currentStorage()
        const thread = storage.createThread({ title: `Discard ${kind} conversation` })
        storage.closeConversation(thread.id)
        const require = globalThis.__anasStorageProbe.nativeRequire
        const directory = require('node:path').join(storage.dataDir, 'db/projects', thread.projectId, 'conversations', thread.id)
        const file = require('node:path').join(directory, 'conversation.sqlite')
        if (kind === 'missing') require('node:fs').rmSync(directory, { recursive: true })
        else if (kind === 'corrupt') require('node:fs').writeFileSync(file, 'damaged database')
        else {
          const database = new (require('better-sqlite3'))(file)
          database.pragma('user_version = 999')
          database.close()
        }
        return thread.id
      }, kind)
      await assert.rejects(page.evaluate(id => globalThis.gale.agent.threads.get(id), lost))
      await page.evaluate(id => globalThis.gale.agent.threads.delete(id), lost)
      const remaining = await page.evaluate(() => globalThis.gale.agent.threads.list())
      assert.equal(remaining.some(thread => thread.id === lost), false)
      assert.equal(remaining.some(thread => thread.id === seeded.threads[0]), true)
    }
    console.log(`Current storage Electron E2E passed: ${JSON.stringify({ messages: count, seedMs: seeded.seedMs, ...result, frameMaxMs, interactionMs })}`)
  } catch (error) {
    console.error(`Current storage E2E failed during ${phase}:`, error)
    throw error
  } finally {
    await closeElectronTestApplication(application, () => application.evaluate(async () => {
      const probe = globalThis.__anasStorageProbe
      if (probe?.job) { probe.stop = true; await probe.job.catch(() => undefined) }
      else probe?.releaseExecution?.()
    }))
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch((error) => {
      console.error(`Could not remove isolated storage fixture ${root}:`, error.message)
    })
  }
}

module.exports = { verifyCurrentStorage }

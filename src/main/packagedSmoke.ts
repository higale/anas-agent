import { app } from 'electron'
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { configureDataRuntime } from './config/dataDir'
import type { ShellTerminalControl } from './ptyShellSupervisor'

function denyNetwork(): never {
  throw new Error('Packaged Agent smoke attempted network access.')
}

export async function runPackagedSmoke(): Promise<void> {
  globalThis.fetch = denyNetwork
  http.request = denyNetwork as typeof http.request
  http.get = denyNetwork as typeof http.get
  https.request = denyNetwork as typeof https.request
  https.get = denyNetwork as typeof https.get
  net.connect = denyNetwork as typeof net.connect
  net.createConnection = denyNetwork as typeof net.createConnection
  tls.connect = denyNetwork as typeof tls.connect

  const { resolveRendererLocation } = await import('./ipcSecurity')
  const rendererLocation = resolveRendererLocation({
    isPackaged: true,
    rendererFile: join(__dirname, '../renderer/index.html'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL
  })
  if (rendererLocation.kind !== 'local') {
    throw new Error('Packaged application accepted an environment-provided renderer URL.')
  }
  if (process.platform === 'win32') {
    const { createWindowsKillOnCloseJob } = await import('./windowsProcessJob')
    const job = createWindowsKillOnCloseJob()
    job.close()
  }

  const root = await mkdtemp(join(tmpdir(), 'anas-packaged-smoke-'))
  try {
    const documents = join(root, 'Documents')
    // The isolated smoke profile has no OS-created personal folders. Bind all
    // paths consumed by runtime approval setup to fixtures, never the real user.
    for (const name of ['desktop', 'downloads', 'documents', 'pictures'] as const) {
      const directory = name === 'documents' ? documents : join(root, name)
      await mkdir(directory)
      app.setPath(name, directory)
    }
    const { readFileContentInfo } = await import('./fileMetadata')
    const imagePath = join(documents, 'metadata.png')
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'))
    const imageFile = await open(imagePath, 'r')
    try {
      const metadata = await readFileContentInfo(imageFile, await imageFile.stat(), imagePath)
      if (metadata.media?.kind !== 'image' || metadata.media.width !== 1 || metadata.media.height !== 1 || metadata.media.hasAlpha !== true) {
        throw new Error(`Packaged local media metadata failed: ${JSON.stringify(metadata)}`)
      }
    } finally { await imageFile.close() }
    configureDataRuntime([process.execPath, '--data-dir=' + root])
    const { initializeBundledExamples } = await import('./bundledExamples')
    const { PluginStore } = await import('./plugins/pluginStore')
    await initializeBundledExamples()
    const examples = join(root, 'examples/plugins')
    const plugins = new PluginStore(root)
    for (const name of await readdir(examples)) {
      if (!name.endsWith('.zip')) continue
      const plugin = await plugins.install(join(examples, name))
      if (plugin.error) throw new Error(`Packaged plugin example failed: ${plugin.error}`)
    }
    const { bundledSearchEnvironment } = await import('./bundledRipgrep')
    const { createShellCommandAuthorization } = await import('./shellCommandAuthorization')
    const { getCommandShell, prepareShellCommand, runShellCommand, runPreparedProcess } = await import('./shellRuntime')
    await writeFile(join(documents, 'search smoke 中文.txt'), 'packaged-search-marker\n', 'utf8')
    // Exercise the packaged default zsh contract independently of personal aliases.
    const searchEnvironment = await bundledSearchEnvironment({ ...process.env,
      ...(process.platform === 'darwin' ? { ZDOTDIR: root } : {}) })
    const shell = await getCommandShell()
    const authorization = createShellCommandAuthorization({ shell, env: searchEnvironment.env, rgExecutable: searchEnvironment.executable,
      primaryFolder: documents, trustedFolders: [documents], accessMode: () => 'strict_approval' })
    const searchArgs = Object.freeze({ command: "rg -n -g '*.txt' packaged-search-marker .", working_dir: documents })
    const needsApproval = await authorization.requiresApproval(searchArgs)
    if ((process.platform === 'win32' || process.platform === 'darwin' && shell.executable === '/bin/zsh') && needsApproval) {
      throw new Error('Packaged rg read analysis did not auto-approve the fixture.')
    }
    const prepared = await prepareShellCommand({ command: String(searchArgs.command), workingDir: String(searchArgs.working_dir) }, documents)
    if ('ok' in prepared) throw new Error(prepared.error)
    prepared.env = searchEnvironment.env
    prepared.pathPrepend = searchEnvironment.directory
    let searchSucceeded = false
    const search = await runShellCommand(prepared, shell, undefined, {
      onResult: (result) => { searchSucceeded = result.ok }
    })
    if (!searchSucceeded || !search.includes('1:packaged-search-marker')) {
      throw new Error(`Packaged ripgrep Shell search failed: ${search}`)
    }
    let terminalSucceeded = false
    let terminalInputResult: Promise<void> | undefined
    let terminalControl: ShellTerminalControl | undefined
    let terminalReadyOutput = ''
    const sendTerminalInputWhenReady = () => {
      if (!terminalControl || terminalInputResult || !terminalReadyOutput.includes('ANAS_PTY_READY')) return
      const terminal = terminalControl
      terminalInputResult = Promise.resolve().then(() => terminal.apply({ type: 'text', text: '中文 smoke\r' }))
      void terminalInputResult.catch(() => {}) // Observed after the executor has drained.
    }
    const terminalOutput = await runPreparedProcess({
      command: 'packaged PTY input probe', workingDir: documents, timeoutSec: 15,
      pty: { columns: 100, rows: 30 }, invocation: { executable: process.platform === 'win32' ? shell.executable : process.execPath,
        // UTF-16 input selects .NET's native ReadConsoleW path, avoiding Windows console code-page conversion.
        args: process.platform === 'win32'
          ? ['-NoLogo', '-NoProfile', '-Command', "[Console]::InputEncoding=[Text.Encoding]::Unicode; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); if([Console]::IsInputRedirected -or [Console]::IsOutputRedirected){exit 2}; Write-Output ANAS_PTY_READY; $line=[Console]::ReadLine(); Write-Output ('PTY_REPLY:'+$line)"]
          : ['-e', `if(!process.stdin.isTTY||!process.stdout.isTTY)process.exit(2);process.stdin.once('data',v=>{console.log('PTY_REPLY:'+String(v).trim());process.exit(0)});console.log('ANAS_PTY_READY')`],
        windowsHide: true, env: { ELECTRON_RUN_AS_NODE: '1' } },
      logScope: 'packaged-smoke', successMessage: 'PTY smoke passed.', failureMessage: 'PTY smoke failed.',
      abortBeforeStartError: 'PTY cancelled before start.', abortError: 'PTY cancelled.', timeoutError: 'PTY smoke timed out.'
    }, undefined, { onTerminal: (terminal) => {
      terminalControl = terminal
      sendTerminalInputWhenReady()
    }, onOutput: (_, text) => {
      if (terminalInputResult) return
      terminalReadyOutput = (terminalReadyOutput + text).slice(-1024)
      sendTerminalInputWhenReady()
    },
      onResult: (result) => { terminalSucceeded = result.ok } })
    await terminalInputResult
    if (!terminalSucceeded || !terminalOutput.includes('PTY_REPLY:中文 smoke')) throw new Error(`Packaged terminal probe failed: ${terminalOutput}`)
    const [{ AgentStorage }, { NativeRuntimeCoordinator }, { createAgentRunSubmissionExecutionInput }, appConfig] = await Promise.all([
      import('./agent/agentStorage'),
      import('./agent/nativeRuntimeCoordinator'),
      import('./agent/agentRunInput'),
      import('./config/appConfig')
    ])
    await appConfig.initializeAppProfile()
    const providerConfig = await appConfig.saveModelProvider({
      name: 'Packaged smoke',
      protocol: 'openai_chat_completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      modelListUrl: '{base_url}/models',
      apiKey: 'packaged-smoke-key',
      parameters: {}
    })
    const provider = providerConfig.providers.at(-1)
    if (!provider) throw new Error('Packaged Agent smoke did not create its model provider.')
    const modelConfig = await appConfig.saveProviderModel({
      providerId: provider.id,
      displayName: 'Packaged smoke',
      model: 'packaged-smoke',
      parameters: {},
      parameterPresetMode: 'none',
      capabilities: { vision: false, toolUse: true },
      stream: false,
      maxContextTokens: 64_000,
      maxOutputTokens: 2_000,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: true
    })
    const smokeModel = modelConfig.providers.find((entry) => entry.id === provider.id)?.models.at(-1)
    if (!smokeModel) throw new Error('Packaged Agent smoke did not create its model configuration.')
    let requests = 0
    let storage = AgentStorage.openNative(root)
    const runtime = new NativeRuntimeCoordinator(storage, { push() {} }, { prepareWorkspace: false,
      providerFetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body))
        if (request.model !== 'packaged-smoke' || request.stream !== false) throw new Error('Packaged native model request is invalid.')
        requests++
        return new Response(JSON.stringify({ id: 'smoke-' + requests, object: 'chat.completion', created: 1,
          model: request.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Native smoke answer ' + requests } }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }), { headers: { 'content-type': 'application/json' } })
      } })
    try {
      const input = createAgentRunSubmissionExecutionInput({ requestId: randomUUID(), text: 'Packaged runtime smoke',
        newThread: { title: 'Packaged smoke', modelConfigId: smokeModel.id } })
      const first = await runtime.submitRunWithAttachments(input)
      if (!first.handle) throw new Error('Packaged native run was not dispatched.')
      const firstOutcome = await first.handle.completed
      if (firstOutcome.status !== 'completed') throw new AggregateError(first.handle.diagnostics,
        'Packaged native run did not complete: ' + (firstOutcome.error ?? firstOutcome.status))
      await first.handle.drained
      const second = await runtime.submitRunWithAttachments(createAgentRunSubmissionExecutionInput({ requestId: randomUUID(),
        threadId: first.thread.id, text: 'Continue the same conversation' }))
      if (!second.handle) throw new Error('Packaged native continuation was not dispatched.')
      const secondOutcome = await second.handle.completed
      if (secondOutcome.status !== 'completed') throw new AggregateError(second.handle.diagnostics,
        'Packaged native continuation did not complete: ' + (secondOutcome.error ?? secondOutcome.status))
      await second.handle.drained
      const duplicate = await runtime.submitRunWithAttachments(input)
      if (duplicate.run.id !== first.run.id || requests !== 2) throw new Error('Packaged native submission was replayed.')
      if (!(await runtime.shutdown()).drained) throw new Error('Packaged native runtime did not drain.')
      storage.close()
      storage = AgentStorage.openNative(root)
      const snapshot = storage.conversationForThread(first.thread.id).readSnapshot(first.thread.id)
      if (snapshot.messages.filter(message => message.role === 'assistant').length !== 2
        || !JSON.stringify(snapshot.messages).includes('Native smoke answer 2')) throw new Error('Packaged native history did not survive reopening.')
      process.stdout.write('ANAS_PACKAGED_SMOKE_OK\n')
    } finally {
      await runtime.shutdown()
      storage.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

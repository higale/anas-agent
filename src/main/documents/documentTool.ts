import { app } from 'electron'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, rm, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { armCurrentAgentToolEffect } from '../agent/toolEffectScope'
import { verifyCurrentToolAuthorization } from '../agent/toolAuthorizationRuntime'
import { renameExclusive } from '../renameExclusive'
import { defineTool, jsonToolResult } from '../../runtime/toolDefinition'
import { z } from 'zod/v3'
import { toolSummarySchema } from '../llm/toolSummary'
import type { stageDocument } from './convert'

type Conversion = Awaited<ReturnType<typeof stageDocument>>

async function runConverter(source: string, stage: string, imageDirectory: string, signal: AbortSignal): Promise<Conversion> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [join(app.getAppPath(), 'out/main/documentWorker.js'), source, stage, imageDirectory], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let reply: { result?: Conversion; error?: string } | undefined
    let failure: Error | undefined
    let diagnostics = ''
    worker.stderr?.setEncoding('utf8').on('data', (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-3000) })
    const stop = () => { worker.kill() }
    worker.once('spawn', () => { if (signal.aborted) stop() })
    worker.on('message', value => { reply = value as typeof reply })
    worker.once('error', error => { failure = error })
    worker.once('close', code => {
      signal.removeEventListener('abort', stop)
      if (signal.aborted) reject(signal.reason)
      else if (failure) reject(failure)
      else if (code === 0 && reply?.result) resolve(reply.result)
      else reject(new Error(reply?.error ?? (diagnostics.trim() || 'Document converter exited with code ' + code)))
    })
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
  })
}

export async function convertDocument(source: string, output: string, convert = runConverter, cancellation?: AbortSignal): Promise<string> {
  if (!isAbsolute(source) || !isAbsolute(output)) throw new Error('input_path and output_path must be absolute filenames.')
  const existing = await lstat(output).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e })
  if (existing) throw new Error('Output already exists: ' + output)
  const directory = dirname(output)
  if (!parse(output).base) throw new Error('output_path must be an absolute filename.')
  const imageDirectory = parse(output).name + '_images'
  const images = join(directory, imageDirectory)
  const timeout = AbortSignal.timeout(300_000)
  const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout
  signal.throwIfAborted()
  await mkdir(directory, { recursive: true })
  const stage = await mkdtemp(join(directory, '.anas-md-'))
  try {
    const result = await convert(source, stage, imageDirectory, signal)
    const stagedImages = join(stage, 'images')
    const names = result.images ? await readdir(stagedImages) : []
    await verifyCurrentToolAuthorization()
    signal.throwIfAborted()
    armCurrentAgentToolEffect({ kind: 'document_conversion', target: { input_path: source, output_path: output }, recoveryMode: 'confirm' })
    if (result.images) renameExclusive(stagedImages, images)
    try { renameExclusive(join(stage, 'document.md'), output) }
    catch (error) {
      if (result.images) {
        for (const name of names) await unlink(join(images, name))
        await rmdir(images)
      }
      throw error
    }
    return ['[Converted document · Markdown]', 'Source: ' + JSON.stringify(source), 'Complete Markdown: ' + JSON.stringify(output),
      'Lines: ' + result.lines, 'Bytes: ' + result.bytes].join('\n')
  } finally { await rm(stage, { recursive: true, force: true }) }
}

function absoluteFile(description: string) {
  return z.string().min(1).refine(isAbsolute, 'Supply an absolute filename.').describe(description)
}
export const documentTool = defineTool({
  name: 'document_to_markdown',
  description: 'Convert a local PDF, DOCX or PPTX to a new UTF-8 Markdown file. Saves embedded images beside it in <output stem>_images/ using relative links. Skips PowerPoint ink and its previews. Scans retain images without OCR. Returns paths, line count and byte count.',
  inputSchema: z.object({
    input_path: absoluteFile('Absolute source document path.'),
    output_path: absoluteFile('Absolute path for a new Markdown file. Missing parent directories are created.'),
    summary: toolSummarySchema
  }).strict(),
  execute: async (input, context) => {
    try { return { content: await convertDocument(input.input_path, input.output_path, runConverter, context.signal) } }
    catch (error) { return jsonToolResult({ ok: false, error: error instanceof Error ? error.message : String(error) }) }
  }
})

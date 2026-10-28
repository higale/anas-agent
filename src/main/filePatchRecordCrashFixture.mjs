import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const options = JSON.parse(process.argv[2])
if (options.scenario !== 'file_patch_store') throw new Error('Expected an isolated file transaction crash scenario.')
const server = await createServer({
  root: process.cwd(), cacheDir: options.viteCacheDirectory, configFile: false,
  appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] },
  // A fixed SSR snapshot needs neither client discovery nor workspace watching.
  server: { middlewareMode: true, watch: null, hmr: false },
  resolve: { alias: { '@shared': resolve('src/shared'),
    electron: fileURLToPath(new URL('../test/isolatedElectronApp.mjs', import.meta.url)) } }
})
try {
  const harness = await server.ssrLoadModule('/src/main/filePatchRecordCrashHarness.ts')
  await harness.runFilePatchRecordCrashHarness(options)
  throw new Error('Patch fixture did not reach its requested crash boundary.')
} finally { await server.close() }

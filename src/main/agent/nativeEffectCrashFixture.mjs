import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const options = JSON.parse(process.argv[2])
const server = await createServer({
  root: process.cwd(), cacheDir: resolve(options.root, 'vite-cache'), configFile: false,
  appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null, hmr: false },
  resolve: { alias: { '@shared': resolve('src/shared'),
    electron: fileURLToPath(new URL('../../test/isolatedElectronApp.mjs', import.meta.url)) } }
})
try {
  const harness = await server.ssrLoadModule('/src/main/agent/nativeEffectCrashHarness.ts')
  const result = await harness.runNativeEffectCrashHarness(options)
  process.stdout.write(`ANAS_NATIVE_CRASH_RESULT:${JSON.stringify(result)}\n`)
} finally { await server.close() }
process.exit(0)

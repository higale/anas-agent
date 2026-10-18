import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { mirrorBundledDirectories, validateBundledDirectories } from './bundledDirectories'
import { getBundledExamplesDir, getExamplesDir, getTempDir } from './config/dataDir'
import { validateBundledPluginZip } from './plugins/pluginStore'
import { validateBundledSkill } from './skillsStore'
import { validateBundledTool } from './toolsStore'

let initialization: Promise<void> | undefined

/** Refresh the complete app-owned tree at startup and after backup restoration. */
export function initializeBundledExamples(): Promise<void> {
  if (!initialization) {
    initialization = mirrorBundledDirectories(getBundledExamplesDir(), getExamplesDir(), undefined, async (directory, category) => {
      if (category === 'skills') await validateBundledDirectories(directory, validateBundledSkill)
      else if (category === 'tools') await validateBundledDirectories(directory, validateBundledTool)
      else if (category === 'plugins') {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name)
          if (!entry.isFile()) throw new Error(`Plugin example must be a ZIP file: ${path}`)
          if (/\.zip$/i.test(entry.name)) await validateBundledPluginZip(path, getTempDir())
          else if (!/\.md$/i.test(entry.name)) throw new Error(`Unexpected plugin example resource: ${path}`)
        }
      }
    }).finally(() => { initialization = undefined })
  }
  return initialization
}

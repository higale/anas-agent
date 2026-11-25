import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { validateBundledDirectories } from './bundledDirectories'
import { getBundledExamplesDir, getTempDir } from './config/dataDir'
import { validateBundledPluginZip } from './plugins/pluginStore'
import { validateBundledSkill } from './skillsStore'
import { validateBundledTool } from './toolsStore'
import { readSubagentPackage } from './subagentPackages'

let initialization: Promise<void> | undefined

/** Validate package resources in place; importing creates a separate user copy. */
export function validateBundledExamples(): Promise<void> {
  if (!initialization) {
    initialization = validateBundledDirectories(getBundledExamplesDir(), async (directory, category) => {
      if (category === 'skills') await validateBundledDirectories(directory, validateBundledSkill)
      else if (category === 'tools') await validateBundledDirectories(directory, validateBundledTool)
      else if (category === 'subagents') await validateBundledDirectories(directory, async path => {
        if ((await readSubagentPackage(path)).preset) throw new Error(`Agent examples must be custom packages: ${path}`)
      })
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

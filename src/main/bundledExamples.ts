import { join } from 'node:path'
import { mirrorBundledDirectories, validateBundledDirectories } from './bundledDirectories'
import { getBundledDataDir, getExamplesDir } from './config/dataDir'
import { validateBundledPlugin } from './plugins/pluginStore'
import { validateBundledSkill } from './skillsStore'
import { validateBundledTool } from './toolsStore'

let initialization: Promise<void> | undefined

/** Refresh the complete app-owned tree at startup and after backup restoration. */
export function initializeBundledExamples(): Promise<void> {
  if (!initialization) {
    initialization = mirrorBundledDirectories(join(getBundledDataDir(), 'examples'), getExamplesDir(), undefined, async (directory, category) => {
      if (category === 'skills') await validateBundledDirectories(directory, validateBundledSkill)
      else if (category === 'tools') await validateBundledDirectories(directory, validateBundledTool)
      else if (category === 'plugins') await validateBundledDirectories(directory, path => validateBundledPlugin(path))
    }).finally(() => { initialization = undefined })
  }
  return initialization
}

import { basename, relative } from 'node:path'
import { listPackageFiles, readPackageFile, savePackageFile, validatePackageFileUpdate } from './packageFiles'
import { withSubagentPackage } from './subagentPackages'
import { requireSubagentPackageId } from '@shared/subagentPackages'
import type { PackageFileUpdate } from '@shared/packageFiles'
import { normalizeSubagent, rawSubagentFromSave } from './config/subagentConfigMapper'
import { inspectSkillText } from './skillDefinition'
import { parseCustomTools } from '@shared/customTools'
import { assertToolDirectoryTreeIdle } from './toolsStore'

export const listSubagentFiles = (id: string, path?: string) => withSubagentPackage(id, agent => listPackageFiles(agent.directory!, path))
export const readSubagentFile = (id: string, path: string) => withSubagentPackage(id, async agent => ({ ...await readPackageFile(agent.directory!, path), editable: !agent.preset }))
export function saveSubagentFile(id: string, path: string, update: PackageFileUpdate) {
  return withSubagentPackage(id, async agent => {
    if (agent.preset) throw new Error('System Agent files are read-only.')
    validatePackageFileUpdate(update)
    assertToolDirectoryTreeIdle(agent.directory!)
    const current = await readPackageFile(agent.directory!, path)
    const canonical = relative(agent.directory!, current.resolvedPath).replace(/\\/g, '/')
    if (canonical === 'AGENT.json') {
      const raw = JSON.parse(update.content)
      if (raw.version !== 0 || requireSubagentPackageId(raw.id) !== agent.id || raw.preset !== agent.preset || raw.name !== agent.name) throw new Error('Edit the Agent name in its settings; package identity and preset cannot be changed.')
      rawSubagentFromSave(normalizeSubagent({ ...raw, enabled: agent.enabled, system_prompt: agent.system_prompt }, 0), agent)
    } else if (canonical === 'PROMPT.md' && agent.enabled && !update.content.trim()) throw new Error('Enabled Agent prompt must not be empty.')
    else if (/^skills\/[^/]+\/SKILL\.md$/.test(canonical)) {
      const result = inspectSkillText(update.content, canonical.split('/')[1])
      if ('code' in result) throw new Error(`Invalid Skill: ${result.code}`)
    } else if (/^tools\/[^/]+\/TOOL\.json$/.test(canonical)) parseCustomTools([JSON.parse(update.content)])
    // The standard editor checks the resolved path and revision, including linked resources.
    if (basename(current.path) === 'AGENT.json' && canonical !== 'AGENT.json' && !canonical.startsWith('tools/')) throw new Error('Nested Agent packages are not supported.')
    return { ...await savePackageFile(agent.directory!, path, update), editable: true }
  })
}

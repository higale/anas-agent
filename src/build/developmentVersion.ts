import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

/** Only development repositories carry github/v* synchronization baselines. */
export function getDevelopmentVersion(root: string, version: string): string | undefined {
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  try {
    // An exported source directory may live inside an unrelated Git checkout.
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)) return undefined
    const description = git('describe', '--tags', '--long', '--first-parent', '--abbrev=8', '--match', 'github/v[0-9]*', 'HEAD')
    const match = /^github\/v\d+\.\d+\.\d+-(\d+)-g([a-f0-9]+)$/.exec(description)
    if (!match) return undefined
    const dirty = Boolean(git('status', '--porcelain', '--untracked-files=normal'))
    return `${version}-dev.${match[1]}+g${match[2]}${dirty ? '.dirty' : ''}`
  } catch {
    // Public snapshots and source archives need neither Git nor a development tag.
    return undefined
  }
}

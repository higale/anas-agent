import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

/** Only development repositories carry refs/anas/github/* synchronization baselines. */
export function getDevelopmentVersion(root: string, version: string): string | undefined {
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  try {
    // An exported source directory may live inside an unrelated Git checkout.
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)) return undefined
    const baselines = new Set(git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/anas/github/').split('\n')
      .flatMap(line => /^refs\/anas\/github\/v\d+\.\d+\.\d+ ([a-f0-9]+)$/.exec(line)?.[1] ?? []))
    if (baselines.size === 0) return undefined
    const distance = git('rev-list', '--first-parent', 'HEAD').split('\n').findIndex(commit => baselines.has(commit))
    if (distance < 0) return undefined
    const revision = git('rev-parse', '--short=8', 'HEAD')
    const dirty = Boolean(git('status', '--porcelain', '--untracked-files=normal'))
    return `${version}-dev.${distance}+g${revision}${dirty ? '.dirty' : ''}`
  } catch {
    // Public snapshots and source archives need neither Git nor a synchronization ref.
    return undefined
  }
}

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

/** Development repositories record the source of confirmed releases in refs/anas/github/*. */
export function getDevelopmentVersion(root: string, version: string): string | undefined {
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  try {
    // An exported source directory may live inside an unrelated Git checkout.
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)) return undefined
    const baselines = git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/anas/github/').split('\n')
      .flatMap(line => {
        const match = /^refs\/anas\/github\/v(\d+\.\d+\.\d+) ([a-f0-9]+)$/.exec(line)
        return match ? [{ version: match[1], commit: match[2] }] : []
      })
    if (baselines.length === 0) return undefined
    const commits = git('rev-list', '--first-parent', 'HEAD').split('\n')
    const baselineCommits = new Set(baselines.map(baseline => baseline.commit))
    const distance = commits.findIndex(commit => baselineCommits.has(commit))
    if (distance < 0) return undefined
    const revision = git('rev-parse', '--short=8', 'HEAD')
    const dirty = Boolean(git('status', '--porcelain', '--untracked-files=normal'))
    if (distance === 0 && !dirty && baselines.some(baseline => baseline.commit === commits[0] && baseline.version === version)) return undefined
    return `${version}-dev.${distance}+g${revision}${dirty ? '.dirty' : ''}`
  } catch {
    // Public snapshots and source archives need neither Git nor a synchronization ref.
    return undefined
  }
}

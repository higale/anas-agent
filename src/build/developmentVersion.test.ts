import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDevelopmentVersion } from './developmentVersion'

let root: string
const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
}).trim()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anas-version-'))
  git('init', '-b', 'main')
  git('config', 'user.name', 'Version test')
  git('config', 'user.email', 'version@example.invalid')
  git('config', 'core.hooksPath', join(root, 'no-hooks'))
  writeFileSync(join(root, 'source.txt'), 'released\n')
  git('add', '.')
  git('commit', '-m', 'source snapshot')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('development version from synchronization baselines', () => {
  it('does not treat public release tags as development baselines', () => {
    git('tag', 'v3.1.3')
    expect(getDevelopmentVersion(root, '3.1.3')).toBeUndefined()
  })
  it('counts commits from the baseline without changing the release version', () => {
    git('tag', '-a', 'github/v3.1.3', '-m', 'synced')
    expect(getDevelopmentVersion(root, '3.1.3')).toBe(`3.1.3-dev.0+g${git('rev-parse', '--short=8', 'HEAD')}`)
    git('commit', '--allow-empty', '-m', 'development change')
    expect(getDevelopmentVersion(root, '3.1.3')).toBe(`3.1.3-dev.1+g${git('rev-parse', '--short=8', 'HEAD')}`)
    git('tag', '-a', 'github/v3.1.4', '-m', 'next sync')
    expect(getDevelopmentVersion(root, '3.1.4')).toBe(`3.1.4-dev.0+g${git('rev-parse', '--short=8', 'HEAD')}`)
  })
  it('marks tracked, staged and untracked changes, but ignores build output', () => {
    git('tag', 'github/v3.1.3')
    writeFileSync(join(root, '.git/info/exclude'), 'out/\n')
    mkdirSync(join(root, 'out'))
    writeFileSync(join(root, 'out/bundle.js'), 'build')
    expect(getDevelopmentVersion(root, '3.1.3')).not.toContain('.dirty')
    writeFileSync(join(root, 'source.txt'), 'edited\n')
    expect(getDevelopmentVersion(root, '3.1.3')).toMatch(/\.dirty$/)
    git('add', 'source.txt')
    expect(getDevelopmentVersion(root, '3.1.3')).toMatch(/\.dirty$/)
    git('commit', '-m', 'edit')
    expect(getDevelopmentVersion(root, '3.1.3')).not.toContain('.dirty')
    writeFileSync(join(root, 'new.txt'), 'new')
    expect(getDevelopmentVersion(root, '3.1.3')).toMatch(/\.dirty$/)
  })
  it('uses the current release version while preparing the next sync', () => {
    git('tag', 'github/v3.1.3')
    git('commit', '--allow-empty', '-m', 'prepare release')
    expect(getDevelopmentVersion(root, '3.1.4')).toMatch(/^3\.1\.4-dev\.1\+g/)
  })
  it('counts mainline commits and ignores baseline tags on merged side branches', () => {
    git('tag', 'github/v3.1.3')
    git('checkout', '-b', 'feature')
    git('commit', '--allow-empty', '-m', 'feature one')
    git('commit', '--allow-empty', '-m', 'feature two')
    git('tag', 'github/v9.0.0')
    git('checkout', 'main')
    git('merge', '--no-ff', 'feature', '-m', 'merge feature')
    expect(getDevelopmentVersion(root, '3.1.3')).toMatch(/^3\.1\.3-dev\.1\+g/)
  })
  it('does not inherit metadata from a source archive parent directory', () => {
    git('tag', 'github/v3.1.3')
    const archive = join(root, 'archive')
    mkdirSync(archive)
    expect(getDevelopmentVersion(archive, '3.1.3')).toBeUndefined()
    rmSync(join(root, '.git'), { recursive: true, force: true })
    expect(getDevelopmentVersion(root, '3.1.3')).toBeUndefined()
  })
})

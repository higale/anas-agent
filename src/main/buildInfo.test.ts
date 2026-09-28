import { describe, expect, it } from 'vitest'
import { createAppBuildInfo } from './buildInfo'
import { formatBuildVersion } from '../renderer/src/ui/buildInfo'

const build = { environment: 'production' as const, builtAt: '2026-09-28T00:00:00Z', developmentVersion: '3.1.3-dev.2+g12345678.dirty' }

describe('displayed build versions', () => {
  describe.each([false, true])('development source, packaged=%s', packaged => {
    it.each(['development', 'production'] as const)('retains the marker in a %s build', environment => {
      const builtAt = environment === 'production' ? build.builtAt : ''
      const info = createAppBuildInfo('3.1.3', packaged, { ...build, environment, builtAt })
      expect(info).toEqual({
        version: '3.1.3', environment: 'development', developmentVersion: build.developmentVersion,
        ...(builtAt ? { builtAt } : {})
      })
      expect(formatBuildVersion(info)).toBe(build.developmentVersion)
    })
  })
  it('shows only the release version when packaging a public source snapshot', () => {
    const info = createAppBuildInfo('3.1.3', true, { environment: build.environment, builtAt: build.builtAt })
    expect(info).toEqual({ version: '3.1.3', environment: 'production', builtAt: build.builtAt })
    expect(formatBuildVersion(info)).toBe('3.1.3')
  })
  it.each(['development', 'production'] as const)('supports %s builds without Git metadata', environment => {
    const info = createAppBuildInfo('3.1.3', false, { environment, builtAt: build.builtAt })
    expect(info.environment).toBe(environment)
    expect(formatBuildVersion(info)).toBe('3.1.3')
  })
  it('keeps the loading placeholder when build information is unavailable', () => {
    expect(formatBuildVersion()).toBe('-')
  })
})

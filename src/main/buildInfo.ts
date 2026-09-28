import type { AppBuildInfo } from '@shared/types'

export function createAppBuildInfo(version: string, packaged: boolean, build: {
  environment: AppBuildInfo['environment']
  builtAt: string
  developmentVersion?: string
}): AppBuildInfo {
  if (build.developmentVersion) {
    return {
      version, environment: 'development', developmentVersion: build.developmentVersion,
      ...(build.builtAt ? { builtAt: build.builtAt } : {})
    }
  }
  return packaged || build.environment === 'production'
    ? { version, environment: 'production', builtAt: build.builtAt }
    : { version, environment: 'development' }
}

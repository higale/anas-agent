import type { EnvironmentContextSettings } from '@shared/types'

export function environmentContextFixture(overrides: Partial<EnvironmentContextSettings> = {}): EnvironmentContextSettings {
  return {
    operatingSystem: true,
    bundledRg: true,
    currentDate: true,
    applicationDataDirectory: true,
    userHomeDirectory: true,
    customInformationEnabled: true,
    customInformation: '',
    ...overrides
  }
}

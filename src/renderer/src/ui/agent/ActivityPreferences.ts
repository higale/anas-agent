import { createContext } from 'react'
import type { AppSettings } from '@shared/types'

export type ActivityPreferencesValue = Pick<AppSettings, 'runningProcessDisplay' | 'showModelRounds'>
export const ActivityPreferences = createContext<ActivityPreferencesValue>({ runningProcessDisplay: 'expanded', showModelRounds: true })

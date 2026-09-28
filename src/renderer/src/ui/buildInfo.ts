import type { AppBuildInfo } from '@shared/types'

export function formatBuildVersion(info?: AppBuildInfo): string {
  return (info?.environment === 'development' ? info.developmentVersion ?? info.version : info?.version) ?? '-'
}

export function formatBuildTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const calendarDate = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-')
  const clockTime = [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0')
  ].join(':')
  return `${calendarDate} ${clockTime}`
}

import { extractZipArchive, type ExtractedZipArchive, type ZipArchiveLimits } from './zipArchive'

export type BackupArchiveLimits = ZipArchiveLimits
export type ExtractedBackupArchive = ExtractedZipArchive

const gibibyte = 1024 ** 3
const mebibyte = 1024 ** 2
export const backupArchiveLimits: Readonly<BackupArchiveLimits> = Object.freeze({
  maxArchiveBytes: 8 * gibibyte,
  maxEntries: 100_000,
  maxEntryBytes: 4 * gibibyte,
  maxTotalBytes: 16 * gibibyte,
  maxCompressionRatio: 1_000,
  compressionRatioThresholdBytes: mebibyte,
  maxPathBytes: 1_024
})

export const backupManifestFileName = 'anas-backup.json'
export const backupManifest = { version: 0, storage_layout: 'project-directories' } as const

// Obsolete layout remains on disk, but is neither exported nor restored.
const skippedRootDirs = new Set([
  'dev', 'electron', 'log', 'tmp', 'cache', 'sqlite', 'attachments', 'file_edits', 'conversations', 'assets',
  'skills_examples', 'tools_examples', 'plugins_examples', 'skills_system', 'tools_system', 'plugins_system', 'plugins_data'
])

export function shouldSkipBackupRelativePath(relPath: string): boolean {
  const first = relPath.split(/[\\/]/)[0]?.toLowerCase()
  const normalized = relPath.replaceAll('\\', '/').toLowerCase()
  return skippedRootDirs.has(first)
    || first.startsWith('.avatar-assets-stage-')
    || normalized === 'projects.json' || normalized === 'input_history.json'
    || normalized === 'db/projects.json' || normalized === 'db/conversations' || normalized.startsWith('db/conversations/')
    || normalized === 'projects.json.delete-journal' || normalized === 'projects.json.delete-stage'
}

export async function extractBackupArchive(
  sourcePath: string,
  targetRoot: string,
  limits: BackupArchiveLimits = backupArchiveLimits
): Promise<ExtractedBackupArchive> {
  return extractZipArchive(sourcePath, targetRoot, limits, { skipPath: shouldSkipBackupRelativePath })
}

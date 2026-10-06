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

const skippedRootDirs = new Set(['dev', 'electron', 'log', 'tmp'])

export function shouldSkipBackupRelativePath(relPath: string): boolean {
  const first = relPath.split(/[\\/]/)[0]?.toLowerCase()
  return skippedRootDirs.has(first)
}

export async function extractBackupArchive(
  sourcePath: string,
  targetRoot: string,
  limits: BackupArchiveLimits = backupArchiveLimits
): Promise<ExtractedBackupArchive> {
  return extractZipArchive(sourcePath, targetRoot, limits, { skipPath: shouldSkipBackupRelativePath })
}

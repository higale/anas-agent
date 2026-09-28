export interface PackageFileNode {
  name: string
  path: string
  relativePath: string
  kind: 'directory' | 'text' | 'binary' | 'symlink'
  size?: number
  linkTarget?: string
  resolvedPath?: string
  linkDirectory?: boolean
}

export interface PackageFilePreview {
  name: string
  path: string
  relativePath: string
  size: number
  kind: 'text' | 'binary'
  content?: string
  linkTarget?: string
  resolvedPath: string
}

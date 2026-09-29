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
  revision?: string
  editable?: boolean
  name: string
  path: string
  relativePath: string
  size: number
  kind: 'text' | 'binary'
  content?: string
  linkTarget?: string
  resolvedPath: string
}

export interface PackageFileUpdate {
  content: string
  revision: string
  resolvedPath: string
}

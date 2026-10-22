// Copyright 2025 OpenAI. Licensed under Apache-2.0.
// TypeScript port of openai/codex a6839a481223fb5faab539a9eb2b7174ae29e560:
// apply-patch/src/{parser,streaming_parser,seek_sequence,file_update,text_file}.rs.
// Changes: batch-only API, TypeScript data structures and errors. Filesystem,
// shell extraction and diff rendering stay with the host. See docs/CODEX_PATCH.md.

export interface UpdateFileChunk {
  changeContext?: string
  oldLines: string[]
  newLines: string[]
  contextLineIndices: Array<[number, number]>
  isEndOfFile: boolean
}

export type PatchHunk =
  | { type: 'add'; path: string; contents: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath?: string; chunks: UpdateFileChunk[] }

// Rust str::trim uses Unicode White_Space, unlike JS trim (which also strips
// BOM and does not strip NEL). Keep this distinction for source and markers.
const trim = (text: string): string => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
const trimEnd = (text: string): string => text.replace(/\p{White_Space}+$/u, '')
const begin = '*** Begin Patch', end = '*** End Patch'
const add = '*** Add File: ', update = '*** Update File: ', remove = '*** Delete File: '
const move = '*** Move to: ', eof = '*** End of File', environment = '*** Environment ID:'

function invalidPatch(message: string): never { throw new Error(`invalid patch: ${message}`) }
function invalidHunk(lineNumber: number, message: string): never {
  throw new Error(`invalid hunk at line ${lineNumber}, ${message}`)
}
function newChunk(changeContext?: string): UpdateFileChunk {
  return { ...(changeContext === undefined ? {} : { changeContext }), oldLines: [], newLines: [], contextLineIndices: [], isEndOfFile: false }
}

// parser.rs: Rust lines() splits LF/CRLF but leaves a bare CR intact.
function rustLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  const terminatedCount = lines.length - 1
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line, i) => i < terminatedCount && line.endsWith('\r') ? line.slice(0, -1) : line)
}

function boundaryError(lines: string[]): string | undefined {
  const first = lines[0] === undefined ? undefined : trim(lines[0])
  const last = lines.at(-1) === undefined ? undefined : trim(lines.at(-1)!)
  if (first === begin && last === end) return undefined
  return first !== undefined && first !== begin
    ? `The first line of the patch must be '${begin}'`
    : `The last line of the patch must be '${end}'`
}

export function parsePatch(text: string): { hunks: PatchHunk[]; patch: string; environmentId?: string } {
  let lines = rustLines(trim(text))
  const error = boundaryError(lines)
  if (error) {
    if (lines.length >= 4 && ['<<EOF', "<<'EOF'", '<<"EOF"'].includes(lines[0]) && lines.at(-1)!.endsWith('EOF')) {
      lines = lines.slice(1, -1)
      const innerError = boundaryError(lines)
      if (innerError) invalidPatch(innerError)
    } else invalidPatch(error)
  }
  const patch = lines.join('\n')
  const hunks: PatchHunk[] = []
  let state: 'not-started' | 'started' | 'add' | 'delete' | 'update' | 'ended' = 'not-started'
  let hunkLine = 0, lineNumber = 0, environmentId: string | undefined
  const empty = (chunk: UpdateFileChunk) => !chunk.oldLines.length && !chunk.newLines.length
  const ensureUpdate = (line: string): void => {
    const hunk = hunks.at(-1)
    if (hunk?.type !== 'update') return
    if (!hunk.chunks.length && state === 'update') invalidHunk(hunkLine, `Update file hunk for path '${hunk.path}' is empty`)
    if (hunk.chunks.at(-1) && empty(hunk.chunks.at(-1)!)) {
      invalidHunk(lineNumber, line === end ? 'Update hunk does not contain any lines'
        : `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`)
    }
  }
  const header = (line: string): boolean => {
    if (state === 'started' && line.startsWith(environment)) {
      if (environmentId !== undefined) invalidPatch('apply_patch environment_id cannot be specified more than once')
      environmentId = trim(line.slice(environment.length))
      if (!environmentId) invalidPatch('apply_patch environment_id cannot be empty')
      return true
    }
    if (line === end) { ensureUpdate(line); state = 'ended'; return true }
    for (const [prefix, type] of [[add, 'add'], [remove, 'delete'], [update, 'update']] as const) {
      if (!line.startsWith(prefix)) continue
      ensureUpdate(line)
      const path = line.slice(prefix.length)
      if (type === 'add') hunks.push({ type, path, contents: '' })
      else if (type === 'delete') hunks.push({ type, path })
      else { hunks.push({ type, path, chunks: [] }); hunkLine = lineNumber }
      state = type
      return true
    }
    return false
  }
  const invalidHeader = (line: string): never => invalidHunk(lineNumber,
    `'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`)
  // streaming_parser.rs process_line, with the full batch supplied at once.
  const processLine = (line: string): void => {
    const trimmed = trim(line)
    if (state === 'not-started') {
      if (trimmed !== begin) invalidPatch(`The first line of the patch must be '${begin}'`)
      state = 'started'
      return
    }
    if (state === 'ended') {
      if (trimmed) invalidPatch(`The last line of the patch must be '${end}'`)
      return
    }
    if (state !== 'update') {
      if (header(trimmed)) return
      const last = hunks.at(-1)
      if (state === 'add' && line.startsWith('+') && last?.type === 'add') {
        last.contents += line.slice(1) + '\n'
        return
      }
      invalidHeader(trimmed)
    }
    const updateLine = trimEnd(line)
    if (header(updateLine)) return
    const last = hunks.at(-1)!
    if (last.type !== 'update') throw new Error('Invalid parser state')
    let chunk = last.chunks.at(-1)
    if (chunk?.isEndOfFile) {
      if (!updateLine) return
      if (updateLine !== '@@' && !updateLine.startsWith('@@ ')) {
        invalidHunk(lineNumber, `Expected update hunk to start with a @@ context marker, got: '${line}'`)
      }
    }
    if (!last.chunks.length && last.movePath === undefined && updateLine.startsWith(move)) {
      last.movePath = updateLine.slice(move.length)
      return
    }
    if (updateLine === '@@' || updateLine.startsWith('@@ ')) {
      if (chunk && empty(chunk)) invalidHunk(lineNumber,
        `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`)
      last.chunks.push(newChunk(updateLine === '@@' ? undefined : updateLine.slice(3)))
      return
    }
    if (updateLine === eof) {
      if (chunk && empty(chunk)) invalidHunk(lineNumber, 'Update hunk does not contain any lines')
      if (chunk) chunk.isEndOfFile = true
      return
    }
    if (!line || /^[ +-]/.test(line)) {
      if (!chunk) { chunk = newChunk(); last.chunks.push(chunk) }
      if (!line || line[0] === ' ') {
        const content = line.slice(1)
        chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length])
        chunk.oldLines.push(content)
        chunk.newLines.push(content)
      } else if (line[0] === '+') chunk.newLines.push(line.slice(1))
      else chunk.oldLines.push(line.slice(1))
      return
    }
    invalidHunk(lineNumber, chunk && !empty(chunk)
      ? `Expected update hunk to start with a @@ context marker, got: '${line}'`
      : `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`)
  }
  for (let index = 0; index < lines.length; index++) {
    lineNumber++
    const line = lines[index]
    // push_delta strips one CR at LF; finish special-cases the final marker.
    if (index === lines.length - 1 && trim(line) === end) { ensureUpdate(trim(line)); state = 'ended' }
    else processLine(index < lines.length - 1 && line.endsWith('\r') ? line.slice(0, -1) : line)
  }
  if (state !== 'ended') invalidPatch(`The last line of the patch must be '${end}'`)
  return { hunks, patch, ...(environmentId === undefined ? {} : { environmentId }) }
}

const normalize = (text: string): string => trim(text)
  .replace(/[\u2010-\u2015\u2212]/g, '-')
  .replace(/[\u2018-\u201b]/g, "'")
  .replace(/[\u201c-\u201f]/g, '"')
  .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, ' ')

// seek_sequence.rs: search the entire remaining range at each strictness level
// before trying a weaker comparison. The first match in that level wins.
function seekSequence(lines: string[], pattern: string[], start: number, atEnd: boolean): number | undefined {
  if (!pattern.length) return start
  if (pattern.length > lines.length) return undefined
  const searchStart = atEnd ? Math.max(lines.length - pattern.length, start) : start
  for (const key of [(s: string) => s, trimEnd, trim, normalize]) {
    const expected = pattern.map(key)
    for (let i = searchStart; i <= lines.length - pattern.length; i++) {
      if (expected.every((line, j) => key(lines[i + j]) === line)) return i
    }
  }
  return undefined
}

type Replacement = [start: number, count: number, lines: string[]]
function computeReplacements(lines: string[], path: string, chunks: UpdateFileChunk[]): Replacement[] {
  const replacements: Replacement[] = []
  let lineIndex = 0
  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const index = seekSequence(lines, [chunk.changeContext], lineIndex, false)
      if (index === undefined) throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`)
      lineIndex = index + 1
    }
    if (!chunk.oldLines.length) { replacements.push([lines.length, 0, chunk.newLines]); continue }
    let pattern = chunk.oldLines, newSlice = chunk.newLines
    let found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile)
    if (found === undefined && pattern.at(-1) === '') {
      pattern = pattern.slice(0, -1)
      if (newSlice.at(-1) === '') newSlice = newSlice.slice(0, -1)
      found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile)
    }
    if (found === undefined) throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`)
    let oldStart = 0, newStart = 0
    for (const [oldContext, newContext] of chunk.contextLineIndices) {
      if (oldContext >= pattern.length || newContext >= newSlice.length) break
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push([found + oldStart, oldContext - oldStart, newSlice.slice(newStart, newContext)])
      }
      oldStart = oldContext + 1
      newStart = newContext + 1
    }
    if (oldStart !== pattern.length || newStart !== newSlice.length) {
      replacements.push([found + oldStart, pattern.length - oldStart, newSlice.slice(newStart)])
    }
    lineIndex = found + pattern.length
  }
  return replacements.sort((a, b) => a[0] - b[0])
}

// text_file.rs: preserve each untouched line's ending; inserted lines use the
// first source ending. Updates terminate every resulting line, including EOF.
export function deriveNewContents(source: string, chunks: UpdateFileChunk[], path: string): string {
  const lines: Array<{ text: string; ending: string }> = []
  let start = 0, preferred: string | undefined
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    preferred ??= match[0]
    lines.push({ text: source.slice(start, match.index), ending: match[0] })
    start = match.index + match[0].length
  }
  if (start < source.length) lines.push({ text: source.slice(start), ending: '' })
  preferred ??= '\n'
  const replacements = computeReplacements(lines.map((line) => line.text), path, chunks)
  const result: string[] = []
  let sourceIndex = 0
  const copyThrough = (endIndex: number): void => {
    for (; sourceIndex < endIndex; sourceIndex++) result.push(lines[sourceIndex].text + (lines[sourceIndex].ending || preferred))
  }
  for (const [index, count, inserted] of replacements) {
    copyThrough(index)
    sourceIndex = index + count
    for (const line of inserted) result.push(line + preferred)
  }
  copyThrough(lines.length)
  return result.join('')
}

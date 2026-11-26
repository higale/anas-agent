import { constants } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { strToU8, zipSync, type Unzipped } from 'fflate'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { PDFParse } from 'pdf-parse'
import { pdfPictures } from './pdfPictures'
import { DocumentImages, needsImageFileLink } from './documentImages'
import { elements, equation, MarkdownFragments, ns, serialize, unpackOffice, xml } from './officeXml'
import { slidesMarkdown } from './slides'

function table(rows: string[][]): string {
  if (!rows.some(row => row.some(cell => cell.trim()))) return ''
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const line = (row: string[]) => '| ' + Array.from({ length: width }, (_, i) => (row[i] ?? '').trim().replaceAll('|', '\\|').replace(/\r?\n/g, '<br>')).join(' | ') + ' |'
  return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')
}

async function wordMarkdown(parts: Unzipped, images: DocumentImages): Promise<string> {
  const fragments = new MarkdownFragments()
  for (const [name, bytes] of Object.entries(parts)) {
    if (!/^word\/(?:document|endnotes|footnotes|comments)\.xml$/i.test(name)) continue
    const doc = xml(bytes)
    const formulas = elements(doc, ns.math, 'oMath')
    if (!formulas.length) continue
    for (const formula of formulas) {
      const display = formula.parentNode?.localName === 'oMathPara'
      const run = doc.createElementNS(ns.word, 'w:r'), text = doc.createElementNS(ns.word, 'w:t')
      text.appendChild(doc.createTextNode(fragments.add(equation(formula, display))))
      run.appendChild(text)
      const container = display ? formula.parentNode! : formula
      container.parentNode!.insertBefore(run, container)
      formula.parentNode!.removeChild(formula)
    }
    parts[name] = strToU8(serialize(doc))
  }
  const html = await mammoth.convertToHtml({ buffer: Buffer.from(zipSync(parts, { level: 0 })) }, {
    styleMap: ['u => u'], externalFileAccess: false,
    convertImage: mammoth.images.imgElement(async image => ({ src: images.save(await image.readAsBuffer(), image.contentType) }))
  })
  const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
  markdown.keep(['u', 'sup', 'sub'])
  markdown.addRule('linkedImageFile', {
    filter: node => node.nodeName === 'IMG' && needsImageFileLink(node.getAttribute('src') ?? ''),
    replacement: (_text, node) => {
      const img = node as HTMLImageElement
      const label = (img.alt || 'Image').replace(/[\\[\]]/g, '\\$&')
      return '[' + label + '](' + img.getAttribute('src') + ')'
    }
  })
  markdown.addRule('table', { filter: 'table', replacement: (_text, node) => {
    const rows = Array.from((node as HTMLTableElement).rows).map(row => Array.from(row.cells).map(cell => markdown.turndown(cell.innerHTML)))
    return '\n\n' + table(rows) + '\n\n'
  } })
  return fragments.restore(markdown.turndown(html.value))
}

// Locate the exact cell sequence before replacing it. Unmatched text remains intact.
function pageTextWithTables(text: string, tables: string[][][]): string {
  const extra: string[] = []
  for (const rows of tables) {
    const md = table(rows)
    if (!md) continue
    const cells = rows.flat().join(' ').trim().split(/\s+/)
    const tokens = Array.from(text.matchAll(/\S+/g))
    const start = tokens.findIndex((t, index) => t[0] === cells[0] &&
      index + cells.length <= tokens.length && cells.every((cell, n) => tokens[index + n][0] === cell))
    if (start < 0) extra.push(md)
    else {
      const last = tokens[start + cells.length - 1]
      text = text.slice(0, tokens[start].index) + '\n\n' + md + '\n\n' + text.slice(last.index + last[0].length)
    }
  }
  return [text.trim(), ...extra].filter(Boolean).join('\n\n')
}

async function pdfMarkdown(bytes: Buffer, images: DocumentImages): Promise<string> {
  const pdf = new PDFParse({ data: bytes })
  try {
    const pictures = await pdfPictures(bytes, images)
    const content = await pdf.getText()
    const tablesByPage = new Map((await pdf.getTable()).pages.map(page => [page.num, page.tables]))
    const result: string[] = []
    for (const page of content.pages) {
      const tables = tablesByPage.get(page.num) ?? []
      result.push(pageTextWithTables(page.text, tables))
      result.push(...pictures[page.num - 1])
    }
    return result.filter(Boolean).join('\n\n')
  } finally { await pdf.destroy() }
}

export async function stageDocument(source: string, stage: string, imageDirectory: string) {
  const extension = extname(source).toLowerCase()
  if (!['.docx', '.pptx', '.pdf'].includes(extension)) throw new Error('Supported document formats: PDF, DOCX, PPTX.')
  const file = await open(source, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  let content: Buffer
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('input_path must be a regular file.')
    if (info.size > 64 * 1024 * 1024) throw new Error('Document exceeds the 64 MiB input limit.')
    content = Buffer.alloc(info.size)
    let offset = 0
    while (offset < content.length) {
      const { bytesRead } = await file.read(content, offset, content.length - offset)
      if (!bytesRead) throw new Error('Document changed during conversion.')
      offset += bytesRead
    }
    if ((await file.stat()).size !== offset) throw new Error('Document changed during conversion.')
  } finally { await file.close() }
  const images = new DocumentImages(stage, imageDirectory)
  const text = extension === '.pdf' ? await pdfMarkdown(content, images)
    : extension === '.docx' ? await wordMarkdown(unpackOffice(content), images) : await slidesMarkdown(unpackOffice(content), images)
  if (!text.trim()) throw new Error('No extractable text or images.')
  if (text.includes('\0')) throw new Error('Markdown contains a null character.')
  await writeFile(join(stage, 'document.md'), text, 'utf8')
  const bytes = Buffer.byteLength(text)
  return { images: images.count, bytes, lines: text.split('\n').length - Number(text.endsWith('\n')) }
}

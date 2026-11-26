import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom'
import { unzipSync, type Unzipped } from 'fflate'
import { ommlToLatex } from 'dwml-ts'
import { randomUUID } from 'node:crypto'

export const ns = {
  math: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  word: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  slide: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  drawing: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  drawing14: 'http://schemas.microsoft.com/office/drawing/2010/main',
  rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006'
}

export function unpackOffice(bytes: Uint8Array): Unzipped {
  let entries = 0, expanded = 0
  return unzipSync(bytes, { filter(entry) {
    expanded += entry.originalSize
    if (++entries > 32_000 || expanded > 256 * 1024 * 1024) throw new Error('Office archive exceeds 32,000 entries or 256 MiB of expanded content.')
    return true
  } })
}

export function xml(bytes: Uint8Array, mime = ''): Document {
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be'
    : /charset\s*=\s*["']?([\w-]+)/i.exec(mime)?.[1] ?? /encoding=["']([\w-]+)/i.exec(Buffer.from(bytes.subarray(0, 150)).toString('latin1'))?.[1] ?? 'utf-8'
  return new DOMParser({ onError: (_level, message) => { throw new Error(message) } }).parseFromString(new TextDecoder(encoding, { fatal: true }).decode(bytes), 'application/xml')
}
export const elements = (root: Document | Element, uri: string, name: string): Element[] =>
  Array.from(root.getElementsByTagNameNS(uri, name))
export const children = (root: Element): Element[] => Array.from(root.childNodes).filter((n): n is Element => n.nodeType === 1)
export const serialize = (node: Node) => new XMLSerializer().serializeToString(node)

export class MarkdownFragments {
  private prefix = 'Anas' + randomUUID().replaceAll('-', '') + 'Fragment'
  private values: (string | (() => string))[] = []
  add(value: string | (() => string)): string {
    return this.prefix + (this.values.push(value) - 1) + 'Z'
  }
  restore(markdown: string): string {
    return markdown.replace(new RegExp(this.prefix + '(\\d+)Z', 'g'), (_, index: string) => {
      const item = this.values[Number(index)]
      return typeof item === 'string' ? item : (this.values[Number(index)] = item())
    })
  }
}

export function xmlFragment(source: string, inline: boolean): string {
  let width = inline ? 1 : 3
  for (const run of source.matchAll(/\x60+/g)) width = Math.max(width, run[0].length + 1)
  const fence = '\x60'.repeat(width)
  return inline ? fence + ' ' + source + ' ' + fence : '\n' + fence + 'xml\n' + source + '\n' + fence + '\n'
}

// Only pass structures understood by the LaTeX renderer. Preserve future Office constructs as XML.
const knownMath = new Set(('oMath oMathPara oMathParaPr r rPr t nor sty scr lit brk aln ctrlPr ' +
  'acc accPr bar barPr borderBox borderBoxPr box boxPr d dPr deg degHide den e eqArr eqArrPr ' +
  'f fPr fName func funcPr groupChr groupChrPr lim limLow limLowPr limUpp limUppPr m mPr mr mc mcPr mcs ' +
  'nary naryPr num phantom phantomPr rad radPr sPre sPrePr sSub sSubPr sSubSup sSubSupPr sSup sSupPr ' +
  'sub sup subHide supHide type begChr endChr sepChr chr grow limLoc pos vertJc baseJc').split(/\s+/))

export function equation(node: Element, display: boolean): string {
  const source = serialize(node)
  // The converter flattens unknown nodes and some non-default symbol styles.
  // Keep their Office Math source when the LaTeX representation would lose information.
  const unsupported = elements(node, ns.math, '*').some(el => {
    if (!knownMath.has(el.localName ?? '')) return true
    switch (el.localName) {
      case 'sPre': return true
      case 'scr': return el.getAttributeNS(ns.math, 'val') !== 'roman'
      case 'sty': return ['b', 'bi'].includes(el.getAttributeNS(ns.math, 'val') ?? '')
      case 'd': return children(el).filter(child => child.localName === 'e').length > 1
      case 'nary': return elements(el, ns.math, 'chr').length === 0
      case 'acc': case 'groupChr': return elements(el, ns.math, 'chr').length > 0
      default: return false
    }
  })
  let parent = node.parentElement
  while (parent && !(parent.localName === 'tc' && [ns.drawing, ns.word].includes(parent.namespaceURI ?? ''))) parent = parent.parentElement
  if (parent) display = false
  const latex = unsupported ? '' : ommlToLatex(source)
  const rendered = latex ? (display ? '$$\n' + latex + '\n$$' : '$' + latex + '$') : xmlFragment(source, !display)
  return parent ? rendered.replace(/\s*\n\s*/g, ' ').replaceAll('|', '\\|') : rendered
}

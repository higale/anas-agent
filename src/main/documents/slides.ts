import { extname, posix } from 'node:path'
import { strToU8, zipSync, type Unzipped } from 'fflate'
import type { Document, Element } from '@xmldom/xmldom'
import { children, elements, equation, MarkdownFragments, ns, serialize, xml, xmlFragment } from './officeXml'
import { needsImageFileLink, type DocumentImages } from './documentImages'

function relationships(parts: Unzipped, part: string): Map<string, string> {
  const dir = posix.dirname(part)
  const file = parts[posix.join(dir, '_rels', posix.basename(part) + '.rels')]
  const result = new Map<string, string>()
  if (file) for (const rel of elements(xml(file), '*', 'Relationship')) {
    const id = rel.getAttribute('Id'), target = rel.getAttribute('Target')
    if (id && target && rel.getAttribute('TargetMode') !== 'External') {
      result.set(id, posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(dir, target)))
    }
  }
  return result
}

// A text shape carries a Markdown fragment through the slide reader in its original position.
function textShape(doc: Document, text: string, original?: Element): Element {
  const shape = doc.createElementNS(ns.slide, 'p:sp')
  const properties = doc.createElementNS(ns.slide, 'p:spPr')
  const transform = original && elements(original, '*', 'xfrm')[0]
  if (transform) properties.appendChild(transform.cloneNode(true))
  shape.appendChild(properties)
  const body = doc.createElementNS(ns.slide, 'p:txBody')
  const para = doc.createElementNS(ns.drawing, 'a:p')
  const run = doc.createElementNS(ns.drawing, 'a:r')
  const value = doc.createElementNS(ns.drawing, 'a:t')
  value.appendChild(doc.createTextNode(text))
  run.appendChild(value)
  para.appendChild(run)
  body.appendChild(para)
  shape.appendChild(body)
  return shape
}

type PartValue = { kind: 'ink' | 'xml' | 'damaged' | 'image' | 'missing'; target: string; mime: string; text?: string }
function selectBranches(alternate: Element, parts: Map<Element, PartValue>, previewed: Set<Element>): Element[] {
  const branches = children(alternate)
  const ink = branches.find(b => elements(b, ns.slide, 'contentPart').some(p => parts.get(p)?.kind === 'ink'))
  if (ink) return [ink]
  const isPicture = (el: Element) => el.localName === 'pic' || parts.get(el)?.kind === 'image'
  const members = (el: Element): Element[] => children(el).flatMap(c => c.localName === 'grpSp' ? members(c)
    : ['pic', 'sp', 'graphicFrame', 'cxnSp', 'contentPart'].includes(c.localName ?? '') ? [c] : [])
  let damaged: Element | undefined, partial: Element | undefined, nativeImage: Element | undefined, otherImage: Element | undefined
  for (const choice of branches.filter(b => b.localName === 'Choice')) {
    const shapes = members(choice)
    if (shapes.some(s => parts.get(s)?.kind === 'damaged' && !previewed.has(s))) {
      damaged ??= choice
      if (shapes.some(s => isPicture(s) || s.localName === 'graphicFrame' || parts.get(s)?.kind === 'xml' || elements(s, ns.drawing, 't').some(t => t.textContent))) partial ??= choice
    } else if (shapes.length && shapes.every(isPicture)) {
      if (shapes.some(s => parts.get(s)?.kind === 'image' || previewed.has(s))) nativeImage ??= choice
      else otherImage ??= choice
    } else if (shapes.some(s => ['xml', 'image'].includes(parts.get(s)?.kind ?? '') || previewed.has(s)) || elements(choice, ns.math, 'oMath').length) {
      return [choice]
    }
  }
  let fallback = nativeImage ?? branches.find(b => b.localName === 'Fallback')
  if (!fallback || !children(fallback).length) fallback = otherImage ?? fallback
  if (damaged && (!fallback || !members(fallback).length)) return [partial ?? damaged]
  if (damaged && fallback && members(fallback).every(isPicture)) {
    for (const member of members(fallback)) previewed.add(member)
    if (partial) {
      for (const member of members(partial)) if (parts.get(member)?.kind === 'damaged') previewed.add(member)
      return [partial, fallback]
    }
  }
  return fallback ? [fallback] : []
}

export async function slidesMarkdown(parts: Unzipped, images: DocumentImages): Promise<string> {
  const types = xml(parts['[Content_Types].xml'])
  const overrides = new Map(elements(types, '*', 'Override').map(n => [n.getAttribute('PartName'), n.getAttribute('ContentType') ?? '']))
  const defaults = new Map(elements(types, '*', 'Default').map(n => [n.getAttribute('Extension')?.toLowerCase(), n.getAttribute('ContentType') ?? '']))
  const mime = (target: string) => overrides.get('/' + target) ?? defaults.get(extname(target).slice(1).toLowerCase()) ?? ''
  const fragments = new MarkdownFragments()
  const presentation = 'ppt/presentation.xml'
  const slideRefs = relationships(parts, presentation)
  const slides = elements(xml(parts[presentation]), ns.slide, 'sldId').map(n => slideRefs.get(n.getAttributeNS(ns.rel, 'id') ?? ''))
  for (const [part, bytes] of Object.entries(parts)) {
    if (!/^ppt\/(?:slides|notesSlides)\/[^/]+\.xml$/i.test(part)) continue
    const doc = xml(bytes), rels = relationships(parts, part)
    const info = new Map<Element, PartValue>()
    for (const item of elements(doc, ns.slide, 'contentPart')) {
      const target = rels.get(item.getAttributeNS(ns.rel, 'id') ?? '') ?? ''
      const type = mime(target), base = type.split(';')[0].trim().toLowerCase()
      let kind: PartValue['kind'] = 'missing', text: string | undefined
      if (base === 'application/inkml+xml') kind = 'ink'
      else if (base.startsWith('image/') && parts[target]) kind = 'image'
      else if (parts[target] && (base.endsWith('xml') || target.endsWith('.xml'))) {
        try { text = xmlFragment(serialize(xml(parts[target], type).documentElement!), false); kind = 'xml' }
        catch { kind = 'damaged'; text = '[Unreadable PowerPoint XML: /' + target + ']' }
      }
      info.set(item, { target, mime: type, kind, text })
    }
    const previewed = new Set<Element>()
    for (const alternate of elements(doc, ns.mc, 'AlternateContent').reverse()) {
      for (const branch of selectBranches(alternate, info, previewed)) {
        while (branch.firstChild) alternate.parentNode!.insertBefore(branch.firstChild, alternate)
      }
      alternate.parentNode!.removeChild(alternate)
    }
    for (const shape of [...elements(doc, ns.slide, 'pic'), ...elements(doc, ns.slide, 'contentPart')]) {
      const value = info.get(shape)
      if (value?.kind === 'ink') { shape.parentNode!.removeChild(shape); continue }
      const blip = elements(shape, ns.drawing, 'blip')[0] ?? elements(shape, '*', 'svgBlip')[0]
      const target = value?.target ?? rels.get(blip?.getAttributeNS(ns.rel, 'embed') ?? '')
      const props = elements(shape, '*', 'cNvPr')[0]
      const alt = (props?.getAttribute('descr') || props?.getAttribute('name') || (value?.target ? posix.basename(value.target) : '')).replace(/\s+/g, ' ').replace(/[\\[\]]/g, '\\$&')
      let markdown: string | (() => string) = value?.text ?? alt
      if ((!value || value.kind === 'image') && target && parts[target]) {
        markdown = () => {
          const link = images.save(parts[target], mime(target), extname(target))
          return (needsImageFileLink(link) ? '[' : '![') + alt + '](' + link + ')'
        }
      }
      shape.parentNode!.replaceChild(textShape(doc, fragments.add(markdown), shape), shape)
    }
    for (const wrapper of elements(doc, ns.drawing14, 'm')) {
      const run = doc.createElementNS(ns.drawing, 'a:r'), text = doc.createElementNS(ns.drawing, 'a:t')
      const expr = elements(wrapper, ns.math, 'oMath').map(e => equation(e, e.parentNode?.localName === 'oMathPara')).join(' ')
      text.appendChild(doc.createTextNode(fragments.add(expr)))
      run.appendChild(text)
      wrapper.parentNode!.replaceChild(run, wrapper)
    }
    const index = slides.indexOf(part)
    if (index !== -1) {
      const tree = elements(doc, ns.slide, 'spTree')[0]
      if (tree) tree.insertBefore(textShape(doc, fragments.add('<!-- Slide number: ' + (index + 1) + ' -->')), tree.firstChild)
    }
    parts[part] = strToU8(serialize(doc))
  }
  const { toMarkdown } = await import('@mdgate/pptx')
  return fragments.restore(await toMarkdown(zipSync(parts, { level: 0 })))
}

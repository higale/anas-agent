import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { convertDocument, documentTool } from './documentTool'
import { stageDocument } from './convert'
import { prepareToolPathAuthorization } from '../agent/toolAuthorization'
import { supportsApprovalParameter } from '../../runtime/smartApproval'
import { modelToolJsonSchema } from '../../runtime/toolSchema'
import { toolPathArguments } from '../agent/toolPathArguments'

const source = (name: string) => resolve('src/test/fixtures/documents', name)
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'anas-document-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function convert(name: string) {
  const path = join(root, '报告 (Q1) #2.md')
  const result = await convertDocument(source(name), path, stageDocument)
  const bytes = await readFile(path)
  const md = bytes.toString('utf8')
  expect(result.split('\n')).toEqual(['[Converted document · Markdown]', 'Source: ' + JSON.stringify(source(name)),
    'Complete Markdown: ' + JSON.stringify(path), 'Lines: ' + (md.split('\n').length - Number(md.endsWith('\n'))), 'Bytes: ' + bytes.length])
  const images = await Promise.all([...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(async ([,href]) => {
    const link = decodeURIComponent(href)
    expect(link).toMatch(/^\.\/报告 \(Q1\) #2_images\/image-\d+\.\w+$/)
    return readFile(join(root, link))
  }))
  return { md, images }
}

describe('native document conversion', () => {
  it('describes the source and destination independently in the model schema', () => {
    const schema = modelToolJsonSchema(documentTool.inputSchema)
    expect(schema.required).toEqual(['input_path', 'output_path'])
    expect(schema.properties).toMatchObject({
      input_path: { type: 'string', minLength: 1, description: expect.stringContaining('source') },
      output_path: { type: 'string', minLength: 1, description: expect.stringContaining('new Markdown file') }
    })
  })

  it.each([
    ['equations.pptx', 'emf', true], ['formula.docx', 'wmf', true],
    ['equations.pptx', 'wmf', false], ['formula.docx', 'emf', false]
  ] as const)('exports the visible picture in %s (%s, valid=%s)', async (name, extension, valid) => {
    const parts = unzipSync(await readFile(source(name)))
    const content = valid ? await readFile(source('rectangle.' + extension)) : Buffer.from('damaged picture')
    for (const [file, bytes] of Object.entries(parts)) {
      if (file.endsWith('/media/image1.png')) {
        parts[file.replace('.png', '.' + extension)] = content
        delete parts[file]
      } else if (file.endsWith('.rels') || file === '[Content_Types].xml') {
        parts[file] = strToU8(strFromU8(bytes).replaceAll('image1.png', 'image1.' + extension)
          .replace('Extension="png" ContentType="image/png"', 'Extension="' + extension + '" ContentType="image/x-' + extension + '"'))
      }
    }
    const input = join(root, name), output = join(root, 'picture.md')
    await writeFile(input, zipSync(parts))
    await convertDocument(input, output, stageDocument)
    const dir = join(root, 'picture_images')
    const md = await readFile(output, 'utf8')
    if (valid && process.platform === 'win32') {
      expect(await readdir(dir)).toEqual(['image-1.png'])
      expect(md).toMatch(/!\[[^\]]*\]\(\.\/picture_images\/image-1\.png\)/)
      const picture = await loadImage(await readFile(join(dir, 'image-1.png')))
      expect([picture.width, picture.height]).toEqual([60, 28])
      const ctx = createCanvas(60, 28).getContext('2d')
      ctx.drawImage(picture, 0, 0)
      expect([...ctx.getImageData(30, 14, 1, 1).data]).toEqual([255, 0, 0, 255])
    } else {
      expect(await readdir(dir)).toEqual(['image-1.' + extension])
      expect(await readFile(join(dir, 'image-1.' + extension))).toEqual(content)
      expect(md).toMatch(/(?<!!)\[[^\]]*\]\(\.\/picture_images\/image-1\.(?:emf|wmf)\)/)
    }
  })

  it('preserves Word text styles, an inline equation, tables and inline images', async () => {
    const parts = unzipSync(await readFile(source('formula.docx')))
    const wordTable = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('</w:body>', wordTable + '</w:body>'))
    const input = join(root, 'word.docx'), output = join(root, 'out.md')
    await writeFile(input, zipSync(parts))
    await convertDocument(input, output, stageDocument)
    const md = await readFile(output,'utf8')
    expect(md).toContain('**Quarterly revenue**')
    expect(md).toContain('![Sales trend](./out_images/image-1.png)')
    expect(md).toContain('mathNumerator')
    expect(md).toContain('mathDenom')
    expect(md).toContain('| Revenue |\n| --- |\n| 42 |')
  })
  it('keeps PDF table structure and each cell once', async () => {
    const {md} = await convert('table.pdf')
    expect(md).toContain('| Name | Score |\n| --- | --- |\n| Ada | 42 |')
    expect(md.match(/Ada/g)).toHaveLength(1)
  })
  it('exports both small scanned pages as PNG with relative links', async () => {
    const {md, images} = await convert('scan.pdf')
    expect(md).toContain('![Page 2]')
    expect(images).toHaveLength(2)
    for (const picture of images) expect(picture.subarray(1,4).toString()).toBe('PNG')
    expect(images[0]).not.toEqual(images[1])
  })
  it('renders rotated inline pixels and the alpha mask of a nested PDF image', async () => {
    const { images } = await convert('placed-images.pdf')
    expect(images).toHaveLength(2)
    const [rotated, masked] = await Promise.all(images.map(data => loadImage(data)))
    expect([rotated.width, rotated.height]).toEqual([4, 8])
    const canvas = createCanvas(8, 8), ctx = canvas.getContext('2d')
    ctx.drawImage(rotated, 0, 0)
    expect([...ctx.getImageData(1, 1, 1, 1).data]).toEqual([0, 0, 255, 255])
    expect([...ctx.getImageData(1, 6, 1, 1).data]).toEqual([255, 0, 0, 255])
    ctx.clearRect(0, 0, 8, 8)
    ctx.drawImage(masked, 0, 0)
    expect(ctx.getImageData(1, 1, 1, 1).data[3]).toBe(0)
    expect([...ctx.getImageData(6, 1, 1, 1).data]).toEqual([0, 255, 0, 255])
  })
  it.each(['equations.pptx','math-notes.pptx','ink-mathml.pptx','mixed-ink.pptx','mixed-formulas.pptx','previews.pptx'])('preserves editable content and selects the correct previews in %s', async name => {
    const {md, images} = await convert(name)
    if (name === 'equations.pptx') {
      expect(md).toMatch(/\| Cell \|\n\n\\?\[1\] Footnote/)
      expect(md).toContain('before$x$after')
      expect(md).toContain('$$\ny\n$$')
      expect(md).not.toMatch(/Stroke preview|Equation preview|Alternate diagram/)
      expect(images).toHaveLength(1)
    } else if (name === 'math-notes.pptx') {
      for (const fragment of ['$\\frac{1}{2}$','<m:sPre>', '<m:nary>', '<m:scr', '<m:acc>', '| $x_{i}$ |','Before $x+y$ After']) expect(md).toContain(fragment)
    } else if (name === 'ink-mathml.pptx') {
      expect(md.match(/<mi>café<\/mi>/g)).toHaveLength(2)
      expect(images).toHaveLength(0)
    } else if (name === 'mixed-ink.pptx') {
      expect(images).toHaveLength(1)
      expect(images[0].toString()).toContain('<svg')
      expect(md).toContain('| Q3 | 42 |')
      expect(md.match(/Slide text/g)).toHaveLength(1)
    } else if (name === 'mixed-formulas.pptx') {
      const pages = md.split(/<!-- Slide number: \d+ -->/).slice(1)
      expect(pages).toHaveLength(5)
      for (const page of pages.slice(0,4)) {
        expect(page).toContain('| Sales | 42 |')
        expect(page.match(/Unreadable PowerPoint XML/g)).toHaveLength(1)
        expect(page.match(/!\[Group preview\]/g)).toHaveLength(1)
      }
      expect(pages[4]).toContain('<mi>y</mi>')
      expect(pages[4]).not.toContain('![')
    } else {
      expect(images).toHaveLength(2)
      expect(md.match(/Unreadable PowerPoint XML/g)).toHaveLength(2)
    }
  })
  it('refuses to overwrite existing files or image directories and cleans staging after parse failures', async () => {
    const path = join(root,'out.md'), assets = join(root,'out_images')
    await mkdir(assets)
    await writeFile(join(assets,'mine'),'keep')
    await expect(convertDocument(source('scan.pdf'), path, stageDocument)).rejects.toThrow()
    expect(await readdir(root)).toEqual(['out_images'])
    await writeFile(path,'keep this')
    await expect(convertDocument(source('table.pdf'),path,stageDocument)).rejects.toThrow(/exists/)
    expect(await readFile(path,'utf8')).toBe('keep this')
    const damaged = join(root,'broken.pptx')
    await writeFile(damaged,'broken')
    await expect(convertDocument(damaged,join(root,'missing.md'),stageDocument)).rejects.toThrow()
    expect(await readdir(root)).not.toContain('missing.md')
    expect(await readFile(join(assets,'mine'),'utf8')).toBe('keep')
  })
  it('rejects relative paths, unsupported files, oversized input and empty PDFs without publishing', async () => {
    const output = join(root, 'out.md')
    expect(toolPathArguments('document_to_markdown', { input_path: 'relative', output_path: output })).toBeUndefined()
    await expect(convertDocument('relative.docx', output, stageDocument)).rejects.toThrow(/absolute/)
    await expect(convertDocument(source('table.pdf'), 'relative.md', stageDocument)).rejects.toThrow(/absolute/)
    await expect(convertDocument(join(root,'old.ppt'), output, stageDocument)).rejects.toThrow(/Supported/)
    const large = join(root, 'large.pdf')
    await writeFile(large, '')
    await truncate(large, 64 * 1024 * 1024 + 1)
    await expect(convertDocument(large, output, stageDocument)).rejects.toThrow(/64 MiB/)
    const empty = join(root, 'empty.pdf')
    const data = (await readFile(source('table.pdf'))).toString('latin1').replace(/\((?:Name|Score|Ada|42)\)/g, s => ' '.repeat(s.length - 2) + '()')
    await writeFile(empty, data, 'latin1')
    await expect(convertDocument(empty, output, stageDocument)).rejects.toThrow(/No extractable/)
    expect(await readdir(root)).not.toContain('out.md')
  })
  it('cancels without publishing an output or leaving staged files', async () => {
    const controller = new AbortController()
    const parse = async (_source: string, stage: string) => {
      await writeFile(join(stage, 'document.md'), 'partial')
      controller.abort()
      return { lines: 1, bytes: 7, images: 0 }
    }
    await expect(convertDocument(source('table.pdf'), join(root, 'out.md'), parse, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readdir(root)).toEqual([])
  })
  it('publishes a new file once even when two conversions race', async () => {
    const output = join(root,'nested','a.md')
    const attempts = await Promise.allSettled([1,2].map(() => convertDocument(source('scan.pdf'),output,stageDocument)))
    expect(attempts.map(a => a.status).sort()).toEqual(['fulfilled','rejected'])
    expect((await readdir(join(root,'nested'))).sort()).toEqual(['a.md','a_images'])
    expect(await readdir(join(root,'nested','a_images'))).toHaveLength(2)
  })
  it('applies file-write approval to the output while allowing reads from outside the project', async () => {
    const project = join(root, 'project')
    await mkdir(project)
    const check = (output: string, accessMode: 'strict_approval' | 'smart_approval', needsApproval = true) => prepareToolPathAuthorization({
      toolName: 'document_to_markdown', args: { input_path: source('table.pdf'), output_path: output, needs_approval: needsApproval },
      primaryFolder: project, trustedFolders: [project], directories: { temporary: [], personal: [] }, accessMode
    })
    expect(supportsApprovalParameter({ name: 'document_to_markdown' })).toBe(true)
    expect((await check(join(project, 'table.md'), 'strict_approval')).requiresApproval).toBe(false)
    expect((await check(join(root, 'table.md'), 'strict_approval')).requiresApproval).toBe(true)
    expect((await check(join(root, 'table.md'), 'smart_approval', false)).requiresApproval).toBe(false)
  })
  it('binds the source as a read and the requested output as a write', () => {
    expect(toolPathArguments('document_to_markdown', {input_path:'/input',output_path:'/output'})).toMatchObject([
      {value:'/input', access:'read', semantics:'follow'}, {value:'/output', access:'write', semantics:'entry'}
    ])
  })
})

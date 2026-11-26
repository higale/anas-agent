import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { createCanvas, ImageData } from '@napi-rs/canvas'
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium'
import type { DocumentImages } from './documentImages'

const wasmPath = createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm')
type LinearTransform = [number, number, number, number]
const identity: LinearTransform = [1, 0, 0, 1]

function transform(pdf: WrappedPdfiumModule, object: number, scratch: number, [a, b, c, d]: LinearTransform): LinearTransform {
  if (!pdf.FPDFPageObj_GetMatrix(object, scratch)) throw new Error('Cannot read PDF object transform.')
  const [x, y, z, w] = pdf.pdfium.HEAPF32.subarray(scratch / 4, scratch / 4 + 4)
  return [a * x + c * y, b * x + d * y, a * z + c * w, b * z + d * w]
}

function png(pdf: WrappedPdfiumModule, bitmap: number): Buffer {
  const width = pdf.FPDFBitmap_GetWidth(bitmap), height = pdf.FPDFBitmap_GetHeight(bitmap)
  const format = pdf.FPDFBitmap_GetFormat(bitmap), stride = pdf.FPDFBitmap_GetStride(bitmap)
  if (width <= 0 || height <= 0 || width * height > 25_000_000 || ![1, 2, 3, 4].includes(format)) throw new Error('Unsupported PDF image bitmap.')
  const start = pdf.FPDFBitmap_GetBuffer(bitmap), data = pdf.pdfium.HEAPU8
  const channels = format === 1 ? 1 : format === 2 ? 3 : 4
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    let src = start + y * stride, dest = y * width * 4
    for (let x = 0; x < width; x++, src += channels, dest += 4) {
      pixels[dest] = data[src + (channels === 1 ? 0 : 2)]
      pixels[dest + 1] = data[src + (channels === 1 ? 0 : 1)]
      pixels[dest + 2] = data[src]
      pixels[dest + 3] = format === 4 ? data[src + 3] : 255
    }
  }
  const canvas = createCanvas(width, height)
  canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0)
  return canvas.toBuffer('image/png')
}

// PDFium renders one placed image including its soft mask, rotation and enclosing form transforms.
export async function pdfPictures(bytes: Uint8Array, images: DocumentImages): Promise<string[][]> {
  const pdf = await init({ wasmBinary: Uint8Array.from(await readFile(wasmPath)).buffer })
  pdf.FPDF_InitLibrary()
  const memory = pdf.pdfium.wasmExports
  const input = memory.malloc(bytes.length), scratch = memory.malloc(24)
  let doc = 0
  try {
    if (!input || !scratch) throw new Error('Unable to allocate PDF image workspace.')
    pdf.pdfium.HEAPU8.set(bytes, input)
    doc = pdf.FPDF_LoadMemDocument(input, bytes.length, '')
    if (!doc) throw new Error('Cannot open PDF for image extraction.')
    const pages: string[][] = []
    for (let i = 0; i < pdf.FPDF_GetPageCount(doc); i++) {
      const page = pdf.FPDF_LoadPage(doc, i)
      if (!page) throw new Error('Cannot load PDF page ' + (i + 1))
      const links: string[] = []
      function visit(object: number, parent: LinearTransform, depth: number): void {
        const type = pdf.FPDFPageObj_GetType(object)
        if (type !== 3 && type !== 5) return // FPDF_PAGEOBJ_IMAGE, FPDF_PAGEOBJ_FORM
        const matrix = transform(pdf, object, scratch, parent)
        if (type === 5) {
          if (depth >= 15) return
          for (let n = 0; n < pdf.FPDFFormObj_CountObjects(object); n++) visit(pdf.FPDFFormObj_GetObject(object, n), matrix, depth + 1)
          return
        }
        const [a, b, c, d] = matrix, width = Math.abs(a) + Math.abs(c), height = Math.abs(b) + Math.abs(d)
        if (!width || !height) return
        if (!pdf.FPDFImageObj_GetImagePixelSize(object, scratch, scratch + 4)) throw new Error('Cannot read PDF image size.')
        const [pixelsX, pixelsY] = pdf.pdfium.HEAPU32.subarray(scratch / 4, scratch / 4 + 2)
        const scale = Math.min(Math.max(pixelsX, pixelsY) / Math.max(width, height), 16_384 / Math.max(width, height), Math.sqrt(25_000_000 / (width * height)))
        if (!pdf.FPDFPageObj_GetMatrix(object, scratch)) throw new Error('Cannot read PDF image transform.')
        const original = pdf.pdfium.HEAPF32.slice(scratch / 4, scratch / 4 + 6)
        pdf.pdfium.HEAPF32.set([a * scale, b * scale, c * scale, d * scale, 0, 0], scratch / 4)
        if (!pdf.FPDFPageObj_SetMatrix(object, scratch)) throw new Error('Cannot apply PDF image transform.')
        const bitmap = pdf.FPDFImageObj_GetRenderedBitmap(doc, page, object)
        pdf.pdfium.HEAPF32.set(original, scratch / 4)
        pdf.FPDFPageObj_SetMatrix(object, scratch)
        if (!bitmap) throw new Error('Cannot render PDF image.')
        try { links.push('![Page ' + (i + 1) + '](' + images.save(png(pdf, bitmap), 'image/png') + ')') }
        finally { pdf.FPDFBitmap_Destroy(bitmap) }
      }
      try {
        for (let n = 0; n < pdf.FPDFPage_CountObjects(page); n++) visit(pdf.FPDFPage_GetObject(page, n), identity, 0)
        pages.push(links)
      } finally { pdf.FPDF_ClosePage(page) }
    }
    return pages
  } finally {
    if (doc) pdf.FPDF_CloseDocument(doc)
    memory.free(scratch)
    memory.free(input)
    pdf.FPDF_DestroyLibrary()
  }
}

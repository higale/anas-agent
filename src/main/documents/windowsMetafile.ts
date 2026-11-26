import { createRequire } from 'node:module'

type RenderMetafile = (source: string, destination: string) => boolean
let render: RenderMetafile | undefined

function bindRenderer(): RenderMetafile {
  const ffi = createRequire(import.meta.url)('koffi') as typeof import('koffi').default
  const gdi = ffi.load('gdiplus.dll')
  const startupInput = ffi.struct({
    version: 'uint32', callback: 'void *', suppressBackgroundThread: 'int', suppressExternalCodecs: 'int'
  })
  const start = gdi.func('__stdcall', 'GdiplusStartup', 'int', [ffi.out(ffi.pointer('uintptr_t')), ffi.pointer(startupInput), 'void *'])
  const stop = gdi.func('void __stdcall GdiplusShutdown(uintptr_t)')
  const load = gdi.func('int __stdcall GdipLoadImageFromFile(const char16_t *, _Out_ void **)')
  const width = gdi.func('int __stdcall GdipGetImageWidth(void *, _Out_ uint32 *)')
  const height = gdi.func('int __stdcall GdipGetImageHeight(void *, _Out_ uint32 *)')
  const save = gdi.func('int __stdcall GdipSaveImageToFile(void *, const char16_t *, const void *, void *)')
  const dispose = gdi.func('int __stdcall GdipDisposeImage(void *)')
  // CLSID of the Windows GDI+ PNG encoder.
  const pngEncoder = Buffer.from('06f47c55041ad3119a730000f81ef32e', 'hex')

  return (source, destination) => {
    const token = [0], image = [null]
    if (start(token, { version: 1, suppressExternalCodecs: 1 }, null) !== 0) return false
    try {
      if (load(source, image) !== 0) return false
      const w = [0], h = [0]
      if (width(image[0], w) !== 0 || height(image[0], h) !== 0
        || !w[0] || !h[0] || w[0] * h[0] > 25_000_000) return false
      return save(image[0], destination, pngEncoder, null) === 0
    } finally {
      if (image[0]) dispose(image[0])
      stop(token[0])
    }
  }
}

export function renderWindowsMetafile(source: string, destination: string): boolean {
  render ??= bindRenderer()
  return render(source, destination)
}

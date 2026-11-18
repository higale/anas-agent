/** BMP headers are not supported by image-dimensions. Shared by previews and model limits. */
export function bmpImageDimensions(header: Uint8Array): { width: number; height: number; type: 'bmp' } | undefined {
  if (header.length < 26 || header[0] !== 0x42 || header[1] !== 0x4d) return undefined
  const bytes = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const dibHeaderSize = bytes.getUint32(14, true)
  if (dibHeaderSize === 12) return { height: bytes.getUint16(20, true), type: 'bmp', width: bytes.getUint16(18, true) }
  if (dibHeaderSize < 40) return undefined
  return { height: Math.abs(bytes.getInt32(22, true)), type: 'bmp', width: bytes.getInt32(18, true) }
}

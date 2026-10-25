import { createHash } from 'node:crypto'

// Adapted from node-edge-tts src/drm.ts at 5fd566bbc30e305a605fc0afc99c98bfbad9d8be.
// MIT license and attribution: data/licenses/node-edge-tts.txt.
export const edgeSpeechClientToken = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'

const hashPrefix = 'Copyright (C) Microsoft Corporation. All rights reserved.'
const coefficients: ReadonlyArray<readonly [number, number]> = [
  [0xE82E91B1, 0xB32700D0],
  [0x44DE24C6, 0x88DFF51D],
  [0x3BEB65BC, 0x29514038],
  [0xC89C5933, 0xB328CBDF],
  [0x8D1EC211, 0xD405B4D5],
  [0x314EF5D5, 0x26E55F3C],
  [0xE92491B1, 0x607801C6],
  [0xF0A5B9D5, 0x82B2C1FB],
  [0x06064CF3, 0xFA51A3DA],
  [0xDA79FA60, 0x207CC464],
  [0xBED20560, 0x3C3C74F3],
  [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1],
  [0xCB49E3C6, 0xC5626167]
]

function rotate16(value: number): number {
  return ((value << 16) | (value >>> 16)) >>> 0
}

function cs64Digest(data: Buffer, digest: Buffer): Buffer {
  const keyA = (digest.readUInt32LE(0) | 1) >>> 0
  const keyB = (digest.readUInt32LE(4) | 1) >>> 0
  const factors = [Math.imul(keyA, 0x82893933), Math.imul(keyB, 0x82893933)]
  const terms = coefficients.map(([coefficient], index) => Math.imul(coefficient, factors[index % 2]) >>> 0)
  const offsets = coefficients.map(([, offset]) => offset)
  const padded = Buffer.alloc(Math.ceil((data.length + 1) / 8) * 8)
  padded.set(data, 1)

  for (let index = 0; index < padded.length / 4; index++) {
    const word = padded.readUInt32LE(index * 4)
    let term = Math.imul(word, index % 2 === 0 ? keyA : keyB)
    let offset = Math.imul(rotate16(word), index % 2 === 0 ? 0xEF0569FB : 0xC31713DB)
    if (index === 0) {
      term += Math.imul(0xF2F90B1A, factors[0])
      offset += 0x0B1A0000
    }
    terms.push(term >>> 0)
    offsets.push(offset >>> 0)
  }

  let swapAcc = 0
  let swapLast = 0
  let state = 0
  let acc = 0
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index]
    const y = terms[index + 1]
    let t = rotate16((offsets[index] + x) >>> 0)
    let q = Math.imul(t, 0x76F50F34)
    swapAcc += (Math.imul(rotate16(q), 0xC3EFEA97) + q) >>> 0
    t = rotate16((offsets[index + 1] + y) >>> 0)
    q = Math.imul(t, 0x1881CE3C)
    swapLast = (Math.imul(rotate16(q), 0x35BD1EC9) + q) >>> 0
    swapAcc = (swapAcc + swapLast) >>> 0

    state = (Math.imul(state, keyA) + x) >>> 0
    for (const factor of [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83]) {
      state = Math.imul(rotate16(state), factor) >>> 0
    }
    acc += state
    t = (Math.imul(state, keyB) + y) >>> 0
    t = Math.imul(rotate16(t), 0xA27416F5) >>> 0
    t = Math.imul(rotate16(t), 0xD38396FF) >>> 0
    state = Math.imul(rotate16(Math.imul(rotate16(t), 0x7C932B89)), 0xBFA49F69) >>> 0
    acc = (acc + state) >>> 0
  }

  const result = Buffer.alloc(8)
  result.writeUInt32LE((swapLast ^ state) >>> 0, 0)
  result.writeUInt32LE((swapAcc ^ acc) >>> 0, 4)
  return result
}

export function generateEdgeSpeechToken(unixSeconds = Date.now() / 1000): string {
  if (!Number.isFinite(unixSeconds)) throw new TypeError('Speech token timestamp must be finite.')
  const seconds = BigInt(Math.floor(unixSeconds)) + 11644473600n
  const ticks = (seconds - seconds % 300n) * 10000000n
  const data = Buffer.from(`${ticks}${edgeSpeechClientToken}`, 'ascii')
  const digest = createHash('sha256').update(hashPrefix, 'ascii').update(data).digest()
  return `${cs64Digest(data, digest).toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`
}

import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  extractTrayGlyphPath, packIco, renderMacOSTrayIcon, TRAY_ICON_PATHS, TRAY_ICON_SIZES,
  TRAY_MACOS_PATHS, TRAY_MACOS_SIZES, unpackIco, type IcoEntry,
} from '../scripts/render-tray-icon.ts'

/** Pixel facts one committed macOS template image must satisfy. */
interface TemplateFacts {
  readonly edge: number
  readonly ink: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
  readonly opaque: number
  readonly blackOnly: boolean
}

/** Read a PNG's alpha-only template facts: ink bounds, opaque count, and whether every opaque pixel is black. */
async function templateFacts(png: Buffer): Promise<TemplateFacts> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let left = info.width; let top = info.height; let right = -1; let bottom = -1
  let opaque = 0; let blackOnly = true
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const at = (y * info.width + x) * 4
      if (data[at + 3] === 0) continue
      opaque += 1
      if (data[at] !== 0 || data[at + 1] !== 0 || data[at + 2] !== 0) blackOnly = false
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  return { edge: info.width, ink: { left, top, width: right - left + 1, height: bottom - top + 1 }, opaque, blackOnly }
}

/** Smallest valid-looking PNG stream: signature plus an IHDR chunk declaring the given edge. */
function pngStub(width: number, height = width): Buffer {
  const png = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12)
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  return png
}

describe('tray icon packaging', () => {
  it('packs PNG entries into a Vista-style ICO directory and reads them back', () => {
    const entries: IcoEntry[] = [{ size: 16, png: pngStub(16) }, { size: 256, png: pngStub(256) }]
    const ico = packIco(entries)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(2)
    // 256 px is encoded as 0 in the one-byte edge fields.
    expect([ico.readUInt8(6 + 16), ico.readUInt8(6 + 17)]).toEqual([0, 0])
    expect(ico.readUInt32LE(6 + 12)).toBe(6 + 32)
    expect(unpackIco(ico)).toEqual(entries)
  })

  it('rejects bitmaps that disagree with their declared edge, oversized edges, and non-PNG data', () => {
    expect(() => packIco([{ size: 16, png: pngStub(24) }])).toThrow('is 24x24, expected 16')
    expect(() => packIco([{ size: 512, png: pngStub(512) }])).toThrow('unsupported bitmap edge 512')
    expect(() => packIco([{ size: 16, png: Buffer.from('not a png stream, long enough to be read') }])).toThrow('not a PNG stream')
    expect(() => unpackIco(Buffer.from('BM'))).toThrow('not an ICO file')
    const forged = packIco([{ size: 16, png: pngStub(16) }])
    forged.writeUInt8(20, 6)
    expect(() => unpackIco(forged)).toThrow('declares 20 but holds 16x16')
  })

  it('ships one crisp bitmap per supported display scale in the committed tray icon', () => {
    const entries = unpackIco(readFileSync(TRAY_ICON_PATHS.output))
    expect(entries.map(entry => entry.size)).toEqual([...TRAY_ICON_SIZES])
    for (const entry of entries) expect(entry.png.length).toBeGreaterThan(100)
  })
})

describe('macOS menu bar template image', () => {
  it('ships the 16 pt image and its Retina variant as black glyphs on a transparent background', async () => {
    const [standard, retina] = await Promise.all([
      templateFacts(readFileSync(TRAY_MACOS_PATHS.output)),
      templateFacts(readFileSync(TRAY_MACOS_PATHS.retinaOutput)),
    ])
    expect([standard.edge, retina.edge]).toEqual([...TRAY_MACOS_SIZES])
    for (const facts of [standard, retina]) {
      // A template image is alpha-only: nothing painted, everything drawn in pure black.
      expect(facts.blackOnly).toBe(true)
      expect(facts.opaque).toBeGreaterThan(0)
      // The glyph sits inside the 1 pt margin and fills the optical box on its limiting axis.
      const box = facts.edge - 2 * (facts.edge / TRAY_MACOS_SIZES[0])
      expect(facts.ink.left).toBeGreaterThanOrEqual(1)
      expect(facts.ink.top).toBeGreaterThanOrEqual(1)
      expect(facts.ink.left + facts.ink.width).toBeLessThanOrEqual(facts.edge - 1)
      expect(facts.ink.top + facts.ink.height).toBeLessThanOrEqual(facts.edge - 1)
      expect(Math.max(facts.ink.width, facts.ink.height)).toBeGreaterThanOrEqual(box - 1)
    }
    // Both scales are one drawing: the Retina ink is twice the size within a rounding pixel.
    expect(Math.abs(retina.ink.width - standard.ink.width * 2)).toBeLessThanOrEqual(2)
    expect(Math.abs(retina.ink.height - standard.ink.height * 2)).toBeLessThanOrEqual(2)
    expect(retina.ink.width).toBeGreaterThan(standard.ink.width)
  })

  it('renders a template image from the vector source at the requested edge', async () => {
    const source = readFileSync(TRAY_ICON_PATHS.source)
    const facts = await templateFacts(await renderMacOSTrayIcon(source, TRAY_MACOS_SIZES[0]))
    expect(facts.edge).toBe(TRAY_MACOS_SIZES[0])
    expect(facts.blackOnly).toBe(true)
    expect(facts.opaque).toBeGreaterThan(0)
  })

  it('knocks the whale out of the rounded tile, centred and clear of its edges', async () => {
    const committed = [[TRAY_MACOS_PATHS.output, TRAY_MACOS_SIZES[0]], [TRAY_MACOS_PATHS.retinaOutput, TRAY_MACOS_SIZES[1]]] as const
    for (const [path, edge] of committed) {
      const { data } = await sharp(readFileSync(path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const alpha = (x: number, y: number): number => data.readUInt8((y * edge + x) * 4 + 3)
      // Flood-fill the background from the border: the transparent pixels it cannot reach are the whale,
      // which measuring inside the tile's inscribed square would clip and so hide an offset.
      const background = new Uint8Array(edge * edge)
      const queue: number[] = []
      const visit = (x: number, y: number): void => {
        if (x < 0 || y < 0 || x >= edge || y >= edge) return
        const index = y * edge + x
        if (background[index] === 1 || alpha(x, y) > 100) return
        background[index] = 1
        queue.push(index)
      }
      for (let axis = 0; axis < edge; axis += 1) { visit(axis, 0); visit(axis, edge - 1); visit(0, axis); visit(edge - 1, axis) }
      while (queue.length > 0) {
        const index = queue.pop()!
        const x = index % edge
        const y = (index - x) / edge
        visit(x - 1, y); visit(x + 1, y); visit(x, y - 1); visit(x, y + 1)
      }
      let whale = 0; let tile = 0
      let left: number = edge; let right = -1; let top: number = edge; let bottom = -1
      for (let y = 0; y < edge; y += 1) {
        for (let x = 0; x < edge; x += 1) {
          if (alpha(x, y) > 100) { tile += 1; continue }
          if (background[y * edge + x] === 1) continue
          whale += 1
          if (x < left) left = x
          if (x > right) right = x
          if (y < top) top = y
          if (y > bottom) bottom = y
        }
      }
      const centre = (edge - 1) / 2
      expect(whale / tile).toBeGreaterThan(0.1)
      expect(right - left).toBeGreaterThan(bottom - top)
      expect(Math.abs((left + right) / 2 - centre)).toBeLessThanOrEqual(1)
      expect(Math.abs((top + bottom) / 2 - centre)).toBeLessThanOrEqual(1)
    }
  })

  it('rejects a vector source whose tray glyph is missing', () => {
    expect(() => extractTrayGlyphPath(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))
      .toThrow('requires a tray-glyph path')
  })
})

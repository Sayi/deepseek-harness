/**
 * Render the tray assets from `resources/icon-windows.svg`.
 *
 * Windows shows the tile at 16 logical pixels and picks one of the bundled ICO
 * bitmaps by display scale; each size is rasterized from the vector source
 * separately instead of downscaling one large bitmap, which keeps edges crisp at
 * every scale. macOS shows the product's rounded square instead, so the whale is
 * measured, then knocked out of a black rounded tile that fills a 16 pt optical
 * box at both scales. The committed outputs are
 * `resources/tray-windows.ico`, `resources/tray-macosTemplate.png`, and
 * `resources/tray-macosTemplate@2x.png`; rerun `pnpm run render:tray-icon` in
 * `apps/desktop` after changing the vector source.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Bitmap edge lengths bundled in the tray icon: 16 px at 100 % through 400 % display scale. */
export const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64] as const

/** Vector source and committed outputs of the tray assets. */
export const TRAY_ICON_PATHS = {
  source: fileURLToPath(new URL('../resources/icon-windows.svg', import.meta.url)),
  output: fileURLToPath(new URL('../resources/tray-windows.ico', import.meta.url)),
} as const

/** Committed macOS menu bar template images: the 16 pt image and its Retina variant, both from {@link TRAY_ICON_PATHS.source}. */
export const TRAY_MACOS_PATHS = {
  output: fileURLToPath(new URL('../resources/tray-macosTemplate.png', import.meta.url)),
  retinaOutput: fileURLToPath(new URL('../resources/tray-macosTemplate@2x.png', import.meta.url)),
} as const

/** Pixel edges of the macOS images: 16 pt at 100 % and the 2x Retina variant. */
export const TRAY_MACOS_SIZES = [16, 32] as const

/** Coordinate space of the vector source; sharp's SVG density is scaled against it. */
const SOURCE_EDGE = 1024
const SOURCE_DENSITY = 72
/** ViewBox of the vector source, which pads the 1024-unit tile to 1104 units. */
const SOURCE_VIEWBOX_EDGE = 1104
/** Optical box the menu bar tile is fitted into, and its transparent margin, in points. */
const MACOS_GLYPH_EDGE = 16
const MACOS_GLYPH_MARGIN = 1
/** Corner radius of that tile, and the largest whale edge inside it, as fractions of the tile edge. */
const MACOS_TILE_RADIUS = 0.225
const MACOS_TILE_GLYPH = 0.72
/** Rasterized edge of the whale while measuring it; large enough that the bounds stay exact. */
const MACOS_RASTER_EDGE = 1104
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICON_DIRECTORY_BYTES = 6
const ICON_ENTRY_BYTES = 16

/** One bitmap of an icon file. */
export interface IcoEntry {
  readonly size: number
  /** Complete PNG stream; Windows Vista and later read PNG-compressed entries directly. */
  readonly png: Buffer
}

/**
 * Pack PNG bitmaps into one ICO file.
 * @param entries - Bitmaps in ascending size; each PNG must be square with the declared edge.
 * @returns the ICO bytes.
 */
export function packIco(entries: readonly IcoEntry[]): Buffer {
  const header = Buffer.alloc(ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * entries.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach((entry, index) => {
    if (entry.size < 1 || entry.size > 256) throw new Error(`tray icon: unsupported bitmap edge ${String(entry.size)}`)
    const { width, height } = pngDimensions(entry.png)
    if (width !== entry.size || height !== entry.size) {
      throw new Error(`tray icon: bitmap ${String(index)} is ${String(width)}x${String(height)}, expected ${String(entry.size)}`)
    }
    const at = ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * index
    // 256 px is encoded as 0 in the one-byte edge fields.
    header.writeUInt8(entry.size % 256, at)
    header.writeUInt8(entry.size % 256, at + 1)
    header.writeUInt8(0, at + 2)
    header.writeUInt8(0, at + 3)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(entry.png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, ...entries.map(entry => entry.png)])
}

/**
 * Read the bitmaps back out of one ICO file.
 * @param ico - Bytes written by {@link packIco} or another PNG-entry ICO producer.
 * @returns entries in directory order, each PNG checked against its declared edge.
 */
export function unpackIco(ico: Buffer): IcoEntry[] {
  if (ico.length < ICON_DIRECTORY_BYTES || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error('tray icon: not an ICO file')
  }
  const count = ico.readUInt16LE(4)
  return Array.from({ length: count }, (_, index) => {
    const at = ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * index
    const declared = ico.readUInt8(at)
    const size = declared === 0 ? 256 : declared
    const length = ico.readUInt32LE(at + 8)
    const offset = ico.readUInt32LE(at + 12)
    const png = ico.subarray(offset, offset + length)
    const { width, height } = pngDimensions(png)
    if (width !== size || height !== size) throw new Error(`tray icon: entry ${String(index)} declares ${String(size)} but holds ${String(width)}x${String(height)}`)
    return { size, png }
  })
}

/**
 * Rasterize the vector source at each tray size.
 * @param svg - SVG document with a 1024-unit square viewBox and a `tray-glyph` group.
 * @param sizes - Bitmap edges to render.
 * @returns PNG entries in the given order.
 */
export async function renderTrayIconEntries(svg: Buffer, sizes: readonly number[] = TRAY_ICON_SIZES): Promise<IcoEntry[]> {
  const source = svg.toString('utf8')
  const glyph = '<g id="tray-glyph"'
  if (!source.includes(glyph)) throw new Error('tray icon: SVG requires a tray-glyph group')
  // Scale around the application tile center, retaining its background and the whale's aspect ratio.
  const tray = Buffer.from(source.replace(glyph, `${glyph} transform="translate(552 544) scale(1.2) translate(-552 -544)"`))
  return Promise.all(sizes.map(async size => ({
    size,
    png: await sharp(tray, { density: SOURCE_DENSITY * size / SOURCE_EDGE }).resize(size, size).png().toBuffer(),
  })))
}

/**
 * Extract the whale path from the vector source's `tray-glyph` group.
 * @param svg - SVG document that carries the group.
 * @returns the path data; the group's filter and gradient paint are dropped.
 */
export function extractTrayGlyphPath(svg: Buffer): string {
  const group = /<g id="tray-glyph"[^>]*>\s*<path\b([^>]*)>/u.exec(svg.toString('utf8'))
  const attributes = group?.[1]
  const data = attributes === undefined ? undefined : /\bd="([^"]*)"/u.exec(attributes)?.[1]
  if (data === undefined) throw new Error('tray icon: SVG requires a tray-glyph path')
  return data
}

/**
 * Render one macOS menu bar template image from the tray glyph.
 *
 * The menu bar shows the product's rounded square rather than a bare whale, so the
 * image is that tile in black with the whale knocked out of it: the glyph is
 * rasterized alone only to measure it, then subtracted from the tile through an
 * SVG mask. Every opaque pixel is black and the whale is transparent, which is what
 * a template image requires and what lets macOS invert it for a dark menu bar.
 * @param svg - SVG document that carries the `tray-glyph` path.
 * @param edge - Output edge in pixels: 16 for the image, 32 for its Retina variant.
 * @returns a PNG of the black tile with the whale cut out of it.
 */
export async function renderMacOSTrayIcon(svg: Buffer, edge: number = TRAY_MACOS_SIZES[0]): Promise<Buffer> {
  const path = extractTrayGlyphPath(svg)
  const bounds = await glyphBounds(path)
  const margin = Math.floor(edge * MACOS_GLYPH_MARGIN / MACOS_GLYPH_EDGE)
  const tile = edge - margin * 2
  const radius = tile * MACOS_TILE_RADIUS
  const scale = Math.min(tile * MACOS_TILE_GLYPH / bounds.width, tile * MACOS_TILE_GLYPH / bounds.height)
  // The tile is centred in the canvas, so the whale is placed on the canvas centre rather
  // than on the tile's own half extent, which would offset it by the margin.
  const placement = `translate(${String(edge / 2)} ${String(edge / 2)}) scale(${String(scale)})`
    + ` translate(${String(-bounds.centerX)} ${String(-bounds.centerY)})`
  const square = `<rect x="${String(margin)}" y="${String(margin)}" width="${String(tile)}" height="${String(tile)}" rx="${String(radius)}"`
  const document = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"'
    + ` width="${String(edge)}" height="${String(edge)}" viewBox="0 0 ${String(edge)} ${String(edge)}">`
    + '<defs><mask id="tray-knockout" maskUnits="userSpaceOnUse"'
    + ` x="0" y="0" width="${String(edge)}" height="${String(edge)}">`
    + `${square} fill="#ffffff"/><path d="${path}" fill="#000000" transform="${placement}"/></mask></defs>`
    + `${square} fill="#000000" mask="url(#tray-knockout)"/></svg>`)
  return sharp(document).png().toBuffer()
}

/** Centre and size of the tray glyph in the vector source's coordinate space. */
async function glyphBounds(path: string): Promise<{ centerX: number; centerY: number; width: number; height: number }> {
  const document = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"'
    + ` width="${String(MACOS_RASTER_EDGE)}" height="${String(MACOS_RASTER_EDGE)}"`
    + ` viewBox="0 0 ${String(SOURCE_VIEWBOX_EDGE)} ${String(SOURCE_VIEWBOX_EDGE)}">`
    + `<path d="${path}" fill="#000000"/></svg>`)
  const { data, info } = await sharp(document).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const bounds = opaqueBounds(data, info.width)
  const unitsPerPixel = SOURCE_VIEWBOX_EDGE / info.width
  return {
    centerX: (bounds.left + bounds.width / 2) * unitsPerPixel,
    centerY: (bounds.top + bounds.height / 2) * unitsPerPixel,
    width: bounds.width * unitsPerPixel,
    height: bounds.height * unitsPerPixel,
  }
}

/** Opaque pixel bounds of a raw RGBA raster, rejecting a glyph that rendered empty. */
function opaqueBounds(pixels: Buffer, edge: number): { left: number; top: number; width: number; height: number } {
  let left = edge; let top = edge; let right = -1; let bottom = -1
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      if (pixels[(y * edge + x) * 4 + 3] === 0) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < left || bottom < top) throw new Error('tray icon: the tray glyph renders empty')
  return { left, top, width: right - left + 1, height: bottom - top + 1 }
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('tray icon: bitmap is not a PNG stream')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

async function main(): Promise<void> {
  const source = await readFile(TRAY_ICON_PATHS.source)
  const entries = await renderTrayIconEntries(source)
  await writeFile(TRAY_ICON_PATHS.output, packIco(entries))
  await writeFile(TRAY_MACOS_PATHS.output, await renderMacOSTrayIcon(source, TRAY_MACOS_SIZES[0]))
  await writeFile(TRAY_MACOS_PATHS.retinaOutput, await renderMacOSTrayIcon(source, TRAY_MACOS_SIZES[1]))
  console.info(`tray icon: wrote ${TRAY_ICON_PATHS.output} with ${entries.map(entry => String(entry.size)).join(', ')} px bitmaps`)
  console.info(`tray icon: wrote ${TRAY_MACOS_PATHS.output} and ${TRAY_MACOS_PATHS.retinaOutput} at ${TRAY_MACOS_SIZES.join(', ')} px`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()

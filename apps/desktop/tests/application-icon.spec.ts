/** The macOS application icon is the four-colour whale on its rounded tile. */
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { expect, it } from 'vitest'

/** Google's four flat colours, one per band across the whale. */
const PALETTE = { blue: [66, 133, 244], red: [234, 67, 53], yellow: [251, 188, 5], green: [52, 168, 83] } as const

it('ships the macOS application icon as the four-colour whale on its rounded tile', async () => {
  const png = readFileSync(new URL('../resources/icon-macos.png', import.meta.url))
  const metadata = await sharp(png).metadata()
  expect([metadata.width, metadata.height, metadata.hasAlpha]).toEqual([1024, 1024, true])

  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const bands = new Map<string, number>()
  let whale = 0; let tile = 0
  for (let i = 0; i < info.width * info.height; i += 1) {
    if (data.readUInt8(i * 4 + 3) < 250) continue
    const red = data.readUInt8(i * 4)
    const green = data.readUInt8(i * 4 + 1)
    const blue = data.readUInt8(i * 4 + 2)
    if (red > 240 && green > 240 && blue > 240) { tile += 1; continue }
    for (const [name, [bandRed, bandGreen, bandBlue]] of Object.entries(PALETTE)) {
      if (Math.abs(red - bandRed) + Math.abs(green - bandGreen) + Math.abs(blue - bandBlue) > 30) continue
      whale += 1
      bands.set(name, (bands.get(name) ?? 0) + 1)
      break
    }
  }
  // The rounded tile stays light; the four bands are flat, so every one of them must survive.
  expect(tile).toBeGreaterThan(whale)
  for (const name of Object.keys(PALETTE)) {
    expect(bands.get(name) ?? 0).toBeGreaterThan(whale * 0.05)
  }
  // The tile is inset, so the canvas corners stay transparent.
  expect(data.readUInt8(3)).toBe(0)
})

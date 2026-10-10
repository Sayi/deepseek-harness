import type { MenuItemConstructorOptions } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import { DesktopTray } from '../src/tray.ts'

/** Image returned by the mocked `nativeImage.createFromPath`, carrying the template marker call. */
interface FakeImage {
  readonly path: string
  readonly setTemplateImage: ReturnType<typeof vi.fn>
}

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const trays: FakeTray[] = []
  class FakeTray extends EventEmitter {
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly destroy = vi.fn()
    constructor(readonly image: unknown) { super(); trays.push(this) }
  }
  const images: FakeImage[] = []
  const menus: MenuItemConstructorOptions[][] = []
  return {
    trays, images, FakeTray, menus,
    createFromPath: vi.fn((path: string) => {
      const image: FakeImage = { path, setTemplateImage: vi.fn() }
      images.push(image)
      return image
    }),
    buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => { menus.push(template); return { template } }),
  }
})
vi.mock('electron', () => ({
  Tray: native.FakeTray,
  nativeImage: { createFromPath: native.createFromPath },
  Menu: { buildFromTemplate: native.buildFromTemplate },
}))

afterEach(() => { native.trays.length = 0; native.images.length = 0; native.menus.length = 0; vi.clearAllMocks() })

function setup(locale = 'en', templateImage?: boolean, contextMenu = true) {
  let current = resolveDesktopLocale(locale)
  const open = vi.fn()
  const quit = vi.fn()
  const tray = new DesktopTray({ iconPath: 'C:/app/resources/tray.ico', contextMenu,
    ...(templateImage === undefined ? {} : { templateImage }),
    locale: () => current, open, quit })
  return { tray, open, quit, native: native.trays[0]!, image: native.images.at(-1)!,
    setLocale: (next: string) => { current = resolveDesktopLocale(next) } }
}

function labels(menu: MenuItemConstructorOptions[]): (string | undefined)[] {
  return menu.map(item => item.type === 'separator' ? 'separator' : item.label)
}

it('shows the application icon with its name as the tooltip and an Open / Quit menu', () => {
  const f = setup()
  expect(native.createFromPath).toHaveBeenCalledWith('C:/app/resources/tray.ico')
  expect(f.image.path).toBe('C:/app/resources/tray.ico')
  expect(f.native.setToolTip).toHaveBeenCalledWith('DeepSeek Harness')
  expect(labels(native.menus[0]!)).toEqual(['Open DeepSeek Harness', 'separator', 'Quit DeepSeek Harness'])
  expect(f.native.setContextMenu).toHaveBeenCalledWith({ template: native.menus[0] })
})

it('leaves a painted Windows bitmap untemplated and marks the macOS menu bar image', () => {
  expect(setup().image.setTemplateImage).not.toHaveBeenCalled()
  const f = setup('en', true)
  expect(f.image.setTemplateImage).toHaveBeenCalledWith(true)
})

it('leaves the macOS menu bar item without a menu, so its click reaches the window', () => {
  const f = setup('en', true, false)
  expect(f.native.setToolTip).toHaveBeenCalledWith('DeepSeek Harness')
  expect(f.native.setContextMenu).not.toHaveBeenCalled()
  expect(native.menus).toHaveLength(0)
  f.setLocale('zh')
  f.tray.relabel()
  expect(f.native.setContextMenu).not.toHaveBeenCalled()
  f.native.emit('click')
  expect(f.open).toHaveBeenCalledOnce()
})

it('opens the window on a single click and routes menu entries to the open and quit actions', () => {
  const f = setup()
  f.native.emit('click')
  expect(f.open).toHaveBeenCalledOnce()
  const menu = native.menus[0]!
  ;(menu[0] as { click: () => void }).click()
  ;(menu[2] as { click: () => void }).click()
  expect(f.open).toHaveBeenCalledTimes(2)
  expect(f.quit).toHaveBeenCalledOnce()
})

it('relabels the menu in the current locale and ignores relabel after disposal', () => {
  const f = setup()
  f.setLocale('zh')
  f.tray.relabel()
  expect(labels(native.menus[1]!)).toEqual(['打开 DeepSeek Harness', 'separator', '退出 DeepSeek Harness'])
  f.tray.dispose()
  f.tray.dispose()
  expect(f.native.destroy).toHaveBeenCalledOnce()
  f.tray.relabel()
  expect(native.menus).toHaveLength(2)
})

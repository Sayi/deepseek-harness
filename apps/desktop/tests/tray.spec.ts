import type { MenuItemConstructorOptions } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import { DesktopTray, type DesktopTraySession } from '../src/tray.ts'

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
    readonly popUpContextMenu = vi.fn()
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

afterEach(() => {
  native.trays.length = 0
  native.images.length = 0
  native.menus.length = 0
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

const SESSIONS: readonly DesktopTraySession[] = [
  { sessionId: 's1', title: 'Fix the login redirect', project: 'easygo-service', running: true },
  { sessionId: 's2', title: 'Refactor the tray menu', project: 'desktop', running: false },
]

function setup(options: {
  readonly locale?: string
  readonly platform?: NodeJS.Platform
  readonly templateImage?: boolean
  readonly sessions?: readonly DesktopTraySession[]
  readonly reject?: boolean
} = {}) {
  // The menu folds the workspace name into one line off macOS and uses a sublabel on it.
  vi.stubGlobal('process', { ...process, platform: options.platform ?? 'win32' })
  let current = resolveDesktopLocale(options.locale ?? 'en')
  const open = vi.fn()
  const quit = vi.fn()
  const openSession = vi.fn()
  const settings = vi.fn()
  const tray = new DesktopTray({
    iconPath: 'C:/app/resources/tray.ico',
    ...(options.templateImage === undefined ? {} : { templateImage: options.templateImage }),
    locale: () => current,
    open,
    quit,
    sessions: () => options.reject === true
      ? Promise.reject(new Error('Host is unavailable'))
      : Promise.resolve(options.sessions ?? SESSIONS),
    openSession,
    settings,
  })
  return {
    tray, open, quit, openSession, settings,
    native: native.trays[0]!, image: native.images.at(-1)!,
    setLocale: (next: string) => { current = resolveDesktopLocale(next) },
  }
}

async function rightClick(): Promise<MenuItemConstructorOptions[]> {
  const fake = native.trays.at(-1)!
  fake.emit('right-click')
  await vi.waitFor(() => { expect(fake.popUpContextMenu).toHaveBeenCalled() })
  return native.menus.at(-1)!
}

function labels(menu: MenuItemConstructorOptions[]): (string | undefined)[] {
  return menu.map(item => item.type === 'separator' ? 'separator' : item.label)
}

it('shows the application icon with its name as the tooltip and no persistent menu', () => {
  const f = setup()
  expect(native.createFromPath).toHaveBeenCalledWith('C:/app/resources/tray.ico')
  expect(f.image.path).toBe('C:/app/resources/tray.ico')
  expect(f.native.setToolTip).toHaveBeenCalledWith('DeepSeek Harness')
  // A persistent context menu would also take the single click on macOS.
  expect(f.native.setContextMenu).not.toHaveBeenCalled()
})

it('leaves a painted Windows bitmap untemplated and marks the macOS menu bar image', () => {
  expect(setup().image.setTemplateImage).not.toHaveBeenCalled()
  const f = setup({ templateImage: true })
  expect(f.image.setTemplateImage).toHaveBeenCalledWith(true)
})

it('opens the window on a single click and builds the menu only on a right click', async () => {
  const f = setup()
  f.native.emit('click')
  expect(f.open).toHaveBeenCalledOnce()
  expect(native.menus).toHaveLength(0)
  const menu = await rightClick()
  expect(labels(menu)).toEqual([
    'Recent',
    '● Fix the login redirect — easygo-service',
    'Refactor the tray menu — desktop',
    'separator',
    'Settings…',
    'separator',
    'Quit DeepSeek Harness',
  ])
})

it('routes menu entries to the session, settings, and quit actions', async () => {
  const f = setup()
  const menu = await rightClick()
  const click = (index: number): void => { (menu[index] as { click: () => void }).click() }
  click(1)
  expect(f.openSession).toHaveBeenCalledWith('s1')
  click(2)
  expect(f.openSession).toHaveBeenCalledWith('s2')
  click(4)
  expect(f.settings).toHaveBeenCalledOnce()
  click(6)
  expect(f.quit).toHaveBeenCalledOnce()
})

it('names the empty listing instead of showing a section without entries', async () => {
  setup({ sessions: [] })
  expect(labels(await rightClick())).toEqual([
    'Recent', 'No recent sessions', 'separator', 'Settings…', 'separator', 'Quit DeepSeek Harness',
  ])
})

it('keeps the menu usable when the listing is unavailable', async () => {
  setup({ reject: true })
  expect(labels(await rightClick())[1]).toBe('No recent sessions')
})

it('draws the workspace name as a sublabel on macOS', async () => {
  setup({ platform: 'darwin', templateImage: true })
  const menu = await rightClick()
  expect(menu[1]).toMatchObject({ label: '● Fix the login redirect', sublabel: 'easygo-service' })
})

it('falls back to an untitled label and truncates long titles', async () => {
  setup({ sessions: [
    { sessionId: 's1', project: 'p', running: false },
    { sessionId: 's2', title: 'x'.repeat(80), running: false },
  ] })
  const menu = await rightClick()
  expect(menu[1]!.label).toBe('Untitled session — p')
  expect(menu[2]!.label).toBe(`${'x'.repeat(59)}…`)
})

it('builds each menu in the current locale and ignores relabel after disposal', async () => {
  const f = setup()
  f.setLocale('zh')
  f.tray.relabel()
  expect(f.native.setToolTip).toHaveBeenLastCalledWith('DeepSeek Harness')
  expect(labels(await rightClick()).slice(0, 2)).toEqual(['最近', '● Fix the login redirect — easygo-service'])
  f.tray.dispose()
  f.tray.dispose()
  expect(f.native.destroy).toHaveBeenCalledOnce()
  f.tray.relabel()
  expect(f.native.setToolTip).toHaveBeenCalledWith('DeepSeek Harness')
})

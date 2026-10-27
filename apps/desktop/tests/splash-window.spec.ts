import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  create: vi.fn<(options: unknown) => ReturnType<typeof createWindow>>(),
  root: '/desktop-app',
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => electron.root },
  BrowserWindow: vi.fn(function (options: unknown) { return electron.create(options) }),
}))

const { openSplashWindow, splashWindowOptions } = await import('../src/splash-window.ts')

function createWindow() {
  return {
    loadFile: vi.fn<(path: string) => Promise<undefined>>().mockResolvedValue(undefined),
    isDestroyed: vi.fn().mockReturnValue(false),
    destroy: vi.fn(),
    show: vi.fn(),
  }
}

beforeEach(() => {
  electron.create.mockReset()
})

describe('desktop splash window', () => {
  it('provides frameless transparent 620x400 window options', () => {
    const options = splashWindowOptions()
    expect(options).toMatchObject({
      width: 620,
      height: 400,
      frame: false,
      transparent: true,
      center: true,
      show: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
  })

  it('suppresses opening under test environment by default', () => {
    const result = openSplashWindow()
    expect(result).toBeUndefined()
    expect(electron.create).not.toHaveBeenCalled()
  })

  it('opens and loads splash.html when forced', () => {
    const fake = createWindow()
    electron.create.mockReturnValue(fake)

    const splash = openSplashWindow({ force: true })
    expect(splash).toBeDefined()
    expect(electron.create).toHaveBeenCalledTimes(1)
    expect(fake.loadFile).toHaveBeenCalledWith(join('/desktop-app', 'renderer', 'splash.html'))

    splash?.close()
    expect(fake.destroy).toHaveBeenCalledTimes(1)

    // Repeated close is idempotent
    splash?.close()
    expect(fake.destroy).toHaveBeenCalledTimes(1)
  })

  it('respects custom renderer directory', () => {
    const fake = createWindow()
    electron.create.mockReturnValue(fake)

    const splash = openSplashWindow({ force: true, rendererDir: '/custom/renderer' })
    expect(splash).toBeDefined()
    expect(fake.loadFile).toHaveBeenCalledWith(join('/custom/renderer', 'splash.html'))
  })
})

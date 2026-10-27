/** Native lightweight splash window shown during desktop cold start. */

import { join } from 'node:path'
import { app, BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'

/** Handle to an active desktop splash window. */
export interface DesktopSplashWindow {
  readonly window: BrowserWindow
  close(): void
}

/** Options for opening the splash window. */
export interface DesktopSplashWindowOptions {
  readonly rendererDir?: string
  readonly force?: boolean
}

/**
 * Resolve BrowserWindow options for the splash window.
 * @returns Frameless, transparent, centered window options.
 */
export function splashWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 620,
    height: 400,
    useContentSize: true,
    center: true,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  }
}

/**
 * Open the native splash window immediately on launch.
 * Suppressed under unit tests unless explicitly forced.
 * @param options - Configuration including optional renderer directory and force flag.
 * @returns The active splash window handle, or undefined when suppressed.
 */
export function openSplashWindow(options: DesktopSplashWindowOptions = {}): DesktopSplashWindow | undefined {
  const isTest = process.env.VITEST !== undefined || process.env.NODE_ENV === 'test'
  if (isTest && !options.force && process.env.DSH_DESKTOP_FORCE_SPLASH !== '1') {
    return undefined
  }
  if (process.env.DSH_DESKTOP_NO_SPLASH === '1') {
    return undefined
  }

  const window = new BrowserWindow(splashWindowOptions())
  const rendererDir = options.rendererDir ?? join(app.getAppPath(), 'renderer')
  const splashPath = join(rendererDir, 'splash.html')

  void window.loadFile(splashPath).catch((error: unknown) => {
    console.error('desktop splash: failed to load splash.html', error)
  })

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    if (!window.isDestroyed()) {
      window.destroy()
    }
  }

  return { window, close }
}

/** Windows notification area and macOS menu bar item: the always-present way back to a hidden window, with a Windows-only menu. */

import { Menu, nativeImage, Tray } from 'electron'
import type { DesktopLocale } from './locale.ts'

/** Main-process actions the tray triggers; both run the same paths as the window and application menu. */
export interface DesktopTrayOptions {
  /**
   * Image rendered by `scripts/render-tray-icon.ts`: the multi-size Windows ICO, whose bitmap Windows
   * picks for the display scale, or the macOS template PNG, whose `@2x` sibling Electron loads with it.
   */
  readonly iconPath: string
  /**
   * Mark the image as a macOS template image, so the menu bar paints it in the bar's current color.
   * The Windows ICO carries its own painted bitmaps and stays untemplated.
   */
  readonly templateImage?: boolean
  /**
   * Set a context menu holding the open and quit entries. Windows needs it as the notification area's
   * own way out; macOS sets none, so a click reaches the application and focuses the window instead.
   */
  readonly contextMenu: boolean
  readonly locale: () => DesktopLocale
  /** Show and focus the primary window. */
  readonly open: () => void
  /** Request quit through the same confirmation as every other quit entry. */
  readonly quit: () => void
}

/** Tray icon present for the whole run, not only while the window is hidden. */
export class DesktopTray {
  private tray: Tray | undefined

  /** @param options - Icon path, template and context-menu modes, locale reader, and the open and quit actions. */
  constructor(private readonly options: DesktopTrayOptions) {
    const image = nativeImage.createFromPath(options.iconPath)
    if (options.templateImage === true) image.setTemplateImage(true)
    const tray = new Tray(image)
    this.tray = tray
    tray.on('click', () => { options.open() })
    this.relabel()
  }

  /** Rebuild the tooltip, and the context menu where one is wanted, in the current locale. */
  relabel(): void {
    const tray = this.tray
    if (tray === undefined) return
    const { messages } = this.options.locale()
    tray.setToolTip(messages.aboutProduct)
    if (!this.options.contextMenu) return
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: messages.openApplication, click: () => { this.options.open() } },
      { type: 'separator' },
      { label: messages.quitApplication, click: () => { this.options.quit() } },
    ]))
  }

  /** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */
  dispose(): void {
    const tray = this.tray
    this.tray = undefined
    tray?.destroy()
  }
}

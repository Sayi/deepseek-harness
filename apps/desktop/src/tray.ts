/**
 * Windows notification area and macOS menu bar item: the always-present way back to a hidden
 * window, whose right-click menu lists the Sessions worth returning to plus the shell actions.
 */

import { Menu, nativeImage, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { DesktopLocale, DesktopMessages } from './locale.ts'

/** One Session the tray lists, as the Host last reported it. */
export interface DesktopTraySession {
  readonly sessionId: string
  /** Latest log-backed title; absent until the Session records one. */
  readonly title?: string
  /** Display name of the Session's working directory. */
  readonly project?: string
  readonly running: boolean
}

/** Main-process actions the tray triggers; each runs the same path as its window or menu counterpart. */
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
  readonly locale: () => DesktopLocale
  /** Show and focus the primary window. */
  readonly open: () => void
  /** Request quit through the same confirmation as every other quit entry. */
  readonly quit: () => void
  /** Sessions to list, most recently active last; the shell supplies its last Host answer. */
  readonly sessions: () => Promise<readonly DesktopTraySession[]>
  /** Show the primary window on one Session. */
  readonly openSession: (sessionId: string) => void
  /** Show the primary window with its settings panel open. */
  readonly settings: () => void
}

/** Longest title one menu line carries before the shell truncates it. */
const TRAY_TITLE_MAX_CODE_POINTS = 60

/**
 * Tray icon present for the whole run, not only while the window is hidden.
 *
 * A single click shows the window on every platform. The menu is built when the user right-clicks
 * and opens through `popUpContextMenu` rather than a persistent `setContextMenu`, which on macOS
 * would replace the single click with the menu.
 */
export class DesktopTray {
  private tray: Tray | undefined

  /** @param options - Icon path, template mode, locale reader, listing, and the shell actions. */
  constructor(private readonly options: DesktopTrayOptions) {
    const image = nativeImage.createFromPath(options.iconPath)
    if (options.templateImage === true) image.setTemplateImage(true)
    const tray = new Tray(image)
    this.tray = tray
    tray.on('click', () => { options.open() })
    tray.on('right-click', () => { void this.showMenu() })
    this.relabel()
  }

  /** Refresh the tooltip in the current locale; menu labels are resolved when the menu opens. */
  relabel(): void {
    this.tray?.setToolTip(this.options.locale().messages.aboutProduct)
  }

  /** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */
  dispose(): void {
    const tray = this.tray
    this.tray = undefined
    tray?.destroy()
  }

  /** Ask for the latest listing, then open the menu on the tray icon. */
  private async showMenu(): Promise<void> {
    const tray = this.tray
    if (tray === undefined) return
    let sessions: readonly DesktopTraySession[] = []
    try {
      sessions = await this.options.sessions()
    } catch (error: unknown) {
      // The shell supplies its last Host answer, so a rejection means no listing was ever received.
      console.warn('desktop tray: session listing unavailable', error)
    }
    if (this.tray !== tray) return
    tray.popUpContextMenu(Menu.buildFromTemplate(this.template(sessions)))
  }

  /** Menu template for the listed Sessions in the current locale. */
  private template(sessions: readonly DesktopTraySession[]): MenuItemConstructorOptions[] {
    const messages = this.options.locale().messages
    const items: MenuItemConstructorOptions[] = [{ label: messages.trayRecent, enabled: false }]
    if (sessions.length === 0) items.push({ label: messages.trayNoSessions, enabled: false })
    else for (const session of sessions) items.push(this.sessionItem(session, messages))
    items.push(
      { type: 'separator' },
      { label: messages.traySettings, click: () => { this.options.settings() } },
      { type: 'separator' },
      { label: messages.quitApplication, click: () => { this.options.quit() } },
    )
    return items
  }

  /** One Session entry; macOS draws the workspace name on its own sublabel line. */
  private sessionItem(session: DesktopTraySession, messages: DesktopMessages): MenuItemConstructorOptions {
    const title = truncate(session.title ?? messages.trayUntitled)
    const label = session.running ? `● ${title}` : title
    return {
      ...process.platform === 'darwin'
        ? { label, ...session.project === undefined ? {} : { sublabel: session.project } }
        : { label: session.project === undefined ? label : `${label} — ${session.project}` },
      click: () => { this.options.openSession(session.sessionId) },
    }
  }
}

/**
 * Shorten one menu line to a readable width.
 * @param value - title text to display.
 * @returns the text, truncated with an ellipsis when it exceeds the menu budget.
 */
function truncate(value: string): string {
  const characters = Array.from(value)
  return characters.length <= TRAY_TITLE_MAX_CODE_POINTS
    ? value
    : `${characters.slice(0, TRAY_TITLE_MAX_CODE_POINTS - 1).join('')}…`
}

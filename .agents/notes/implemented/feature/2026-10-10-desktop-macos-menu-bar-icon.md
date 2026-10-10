# Agent Note: Desktop macOS menu bar icon

Status: implemented

English | [中文](2026-10-10-desktop-macos-menu-bar-icon.zh.md)

The macOS status item carries the same Open and Quit entries as the Windows tray, which the [close and quit decision](../architecture/2026-09-23-desktop-close-to-background-and-quit-confirmation.md) owns; this note records only the macOS asset, wiring, and packaging that decision deliberately left out.

## Problem

Closing the Desktop main window hides it: the page and the Host keep running, and the window has to be brought back without losing the document. Windows carries a tray icon for the whole run and a first-hide acknowledgement that names it as the way back. macOS shipped no menu bar icon and relied on the Dock, a second launch, and `dsh://open`, so a user who closed the window had to find its Dock icon among all others or relaunch the application, even though running tasks make the window worth returning to. The product request was a status item present from application startup, so the window is always one click away on the platform where the application is used interactively.

## Decision

macOS carries a menu bar status item, created at startup and present for the whole run, with the same role as the Windows tray: a visible entry point back to the hidden window and one explicit Quit. Windows behavior, assets, and the first-hide acknowledgement are unchanged, and macOS keeps its Dock icon and still asks for no acknowledgement before the first hide.

### Icon assets

`resources/tray-macosTemplate.png` is 16×16 and `resources/tray-macosTemplate@2x.png` is 32×32. Both show the product's rounded square in black with the whale knocked out of it on a transparent background: every opaque pixel is pure black and the whale is transparent, which is what a macOS template image requires and what lets the system invert the tile for a dark menu bar. `apps/desktop/scripts/render-tray-icon.ts` produces both from the single `<path>` inside the `tray-glyph` group of `resources/icon-windows.svg`: it drops the enclosing drop-shadow filter, measures the path's alpha bounds, and subtracts that path from a rounded tile through an SVG mask, with the tile filling a 16 pt optical square inside a 1 pt margin and the whale held at 72 % of the tile's edge. Deriving from the committed vector keeps one artwork source rather than a duplicated path; `pnpm run render:tray-icon` in `apps/desktop` is the only producer of all three committed assets, the Windows ICO included.

### Application integration

`apps/desktop/src/tray.ts` keeps its responsibilities unchanged: tooltip `aboutProduct`, the `openApplication` and `quitApplication` entries around a separator, `click` routed to the open action, `relabel` on locale change, and `dispose` on the confirmed quit. Its options gained `templateImage`, and the constructor calls `setTemplateImage(true)` on the loaded image when it is set, so the menu bar paints the glyph in the bar's current color for the light, dark, and highlighted states. No new locale string exists.

`apps/desktop/src/main.ts` constructs the tray when `process.platform` is `win32` or `darwin`. Windows keeps `resources/tray-windows.ico` in development and `process.resourcesPath/tray.ico` packaged; macOS uses `resources/tray-macosTemplate.png` in development and `process.resourcesPath/tray-macosTemplate.png` packaged, named so Electron loads the `@2x` sibling beside it. A construction failure warns and continues, as before. The open action stays `focusPrimaryWindow`, so the status item restores a hidden or minimized window, re-creates a destroyed one, and respects the mandatory-update overlay exactly as the Dock and the second launch do; Quit stays `app.quit()` and reaches the ordinary quit confirmation. Linux still has no tray, because only macOS and Windows are shipped Desktop targets.

### macOS click behavior

The status item has a context menu, so macOS opens that menu on a click and the `click` handler is the Windows path. The shared class keeps binding it for both platforms rather than branching on the platform, since the handler is correct wherever the event arrives.

### Packaging

`apps/desktop/scripts/electron-builder-config.mjs` adds the two PNGs to `extraResources` under the existing `packagesMacOS` condition, so a macOS build carries only the template images and a Windows build only the ICO.

## Alternatives considered

**Hide the Dock icon while the window is hidden, making this a menu-bar-only application.** Rejected: the Dock is the macOS convention the close-to-background decision already relies on, and hiding it removes the Dock menu's Quit, the About panel's activation, and Cmd+Tab presence that users of a tool with long-running tasks expect.

**Ship the full-color application tile as the menu bar image.** Rejected: a colored tile with its background and shadow violates the template-image contract, cannot invert for dark mode or the highlighted state, and looks foreign beside native status items.

**Reuse `resources/tray-windows.ico` on macOS.** Rejected for the same reason: the multi-size ICO carries the tile background and gradient, and Electron renders ICO entries without template handling.

**Build one cross-platform tray abstraction now, with Linux included.** Rejected for scope. Windows behavior was already correct and Linux is not a shipped target, so the abstraction would have arrived without a second real consumer to validate its shape.

**Add a setting that hides the status item.** Deferred. The request was an always-present icon, and a preference would introduce a durable setting whose default and behavior have no user evidence; the icon is additive and easy to remove if it proves unwelcome.

## Testing

Unit tests pin the committed template images (edges, transparent background, pure-black opaque pixels, the rounded tile filling the 1 pt margin with the whale knocked out of it, and Retina ink at twice the standard ink), the renderer's rejection of a vector source without a tray glyph, the template marking in `DesktopTray`, the macOS and Windows icon paths in `main.ts` with the menu bar item's click and close paths, the per-platform `extraResources` split, and the macOS release configuration's resource list.

The template rendering, the Retina `@2x` load, and the dark-mode inversion are macOS and Electron behaviors no unit test proves. They need one manual pass on a Retina macOS machine, which the proposal's acceptance criteria name and no automated lane covers.

## Consequences

The window is reachable from the menu bar for the whole run on both shipped platforms, and closing it on macOS now has a visible way back that does not depend on the user finding the Dock icon. The change costs a second always-visible surface on macOS with no way to remove it, and it partially supersedes the [close and quit decision](../architecture/2026-09-23-desktop-close-to-background-and-quit-confirmation.md), whose macOS sentence now points here; that note remains the owner of the close, hide, and quit-confirmation behavior.

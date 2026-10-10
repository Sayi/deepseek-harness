/** macOS development bundle that loads the current workspace through Electron. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Workspace and runtime settings captured for Launch Services cold starts. */
export interface DevelopmentAppOptions {
  readonly electron: string
  readonly appRoot: string
  readonly directory: string
  readonly home: string
  readonly userData: string
  readonly mainPort: number
  readonly rendererPort: number
  readonly hostPort: number
  readonly openDevtools: string
}

/** Icon file name inside the bundle; `CFBundleIconFile` names it without the extension. */
const DEVELOPMENT_ICON = 'AppIcon'

/** Apple iconset entries: the member file name and the square edge `sips` renders for it. */
const ICONSET_ENTRIES = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
] as const

/**
 * Application icon the development bundle carries.
 * @param appRoot - Desktop application root that holds the committed resources.
 * @returns path of the exported 1024×1024 macOS icon.
 */
export function developmentAppIconPath(appRoot: string): string {
  return join(appRoot, 'resources', 'icon-macos.png')
}

/**
 * Build the bundle's `.icns` from the exported application icon.
 *
 * The bundle starts as a copy of Electron.app, so without this it keeps Electron's
 * own icon. `iconutil` only accepts an `.iconset` directory whose members use the
 * sizes Apple defines, so `sips` renders each one from the committed 1024 px export.
 * @param bundle - Prepared `.app` directory.
 * @param iconPath - Committed 1024×1024 application icon.
 */
export function installDevelopmentAppIcon(bundle: string, iconPath: string): void {
  const resources = join(bundle, 'Contents', 'Resources')
  const iconset = join(resources, `${DEVELOPMENT_ICON}.iconset`)
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })
  try {
    for (const [member, edge] of ICONSET_ENTRIES) {
      execFileSync('/usr/bin/sips', ['-z', String(edge), String(edge), iconPath, '--out', join(iconset, member)], { stdio: 'pipe' })
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(resources, `${DEVELOPMENT_ICON}.icns`)], { stdio: 'pipe' })
  } finally {
    rmSync(iconset, { recursive: true, force: true })
  }
}

/**
 * Info.plist overrides the development bundle carries.
 * @param options - Current workspace and private development locations.
 * @returns replacement values, keyed by plist key.
 */
export function developmentPlistValues(options: DevelopmentAppOptions): Record<string, unknown> {
  return {
    CFBundleIdentifier: `com.deepseek.harness.dev.${createHash('sha256').update(options.appRoot).digest('hex').slice(0, 12)}`,
    CFBundleName: 'Harness Dev',
    CFBundleDisplayName: 'Harness Dev',
    CFBundleExecutable: 'HarnessDev',
    CFBundleIconFile: `${DEVELOPMENT_ICON}.icns`,
    CFBundleURLTypes: [{ CFBundleURLName: 'DeepSeek Harness', CFBundleURLSchemes: ['dsh'], CFBundleTypeRole: 'Viewer' }],
  }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/**
 * Prepare and register a disposable .app without changing the installed Electron package.
 * @param options - Current workspace, Electron binary, and private development locations.
 * @returns executable used by the supported desktop development launcher.
 */
export function prepareDevelopmentApp(options: DevelopmentAppOptions): string {
  const source = dirname(dirname(dirname(options.electron)))
  const bundle = join(options.directory, 'Harness Dev.app')
  const executable = join(bundle, 'Contents', 'MacOS', 'HarnessDev')
  const stamp = join(bundle, 'Contents', 'Resources', 'dsh-development.json')
  const icon = developmentAppIconPath(options.appRoot)
  const launcher = developmentLauncher(options, bundle)
  const identity = JSON.stringify({ ...options, launcher, icon: createHash('sha256').update(readFileSync(icon)).digest('hex'),
    plist: readFileSync(join(source, 'Contents', 'Info.plist'), 'utf8') })
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== identity) {
    rmSync(bundle, { recursive: true, force: true })
    execFileSync('/usr/bin/ditto', [source, bundle])
    const plist = join(bundle, 'Contents', 'Info.plist')
    for (const [key, value] of Object.entries(developmentPlistValues(options))) {
      execFileSync('/usr/bin/plutil', ['-replace', key, '-json', JSON.stringify(value), plist])
    }
    installDevelopmentAppIcon(bundle, icon)
    writeFileSync(executable, launcher, { mode: 0o755 })
    writeFileSync(stamp, identity, { mode: 0o600 })
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'pipe' })
  }
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', bundle])
  return executable
}

/**
 * Create the development executable used by both the CLI and Launch Services.
 * @param options - Persisted development locations and debugging settings.
 * @param bundle - Generated application bundle.
 * @returns shell program with literal arguments and environment values.
 */
export function developmentLauncher(options: DevelopmentAppOptions, bundle: string): string {
  const environment = {
    DSH_HOME: options.home,
    DSH_DESKTOP_DEV_APP: '1',
    DSH_DESKTOP_HOST_INSPECT_PORT: String(options.hostPort),
    DSH_DESKTOP_OPEN_DEVTOOLS: options.openDevtools,
    ELECTRON_ENABLE_LOGGING: '1',
  }
  const args = [
    join(bundle, 'Contents', 'MacOS', 'Electron'),
    `--inspect=127.0.0.1:${String(options.mainPort)}`,
    `--remote-debugging-port=${String(options.rendererPort)}`,
    `--user-data-dir=${options.userData}`,
    options.appRoot,
  ]
  return [
    '#!/bin/sh',
    ...Object.entries(environment).map(([key, value]) => `export ${key}=${quote(value)}`),
    `cd ${quote(options.appRoot)}`,
    `exec ${args.map(quote).join(' ')} "$@"`,
    '',
  ].join('\n')
}

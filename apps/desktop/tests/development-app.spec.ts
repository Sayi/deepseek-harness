/** Cold-start launcher preserves workspace paths without evaluating shell syntax. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import {
  developmentLauncher, developmentPlistValues, installDevelopmentAppIcon, type DevelopmentAppOptions,
} from '../scripts/development-app.ts'

const options: DevelopmentAppOptions = {
  electron: '/Applications/Electron.app/Contents/MacOS/Electron',
  appRoot: '/workspace',
  directory: '/development',
  home: '/development/home',
  userData: '/development/electron-user-data',
  mainPort: 9229,
  rendererPort: 9222,
  hostPort: 9230,
  openDevtools: '1',
}

it.skipIf(process.platform === 'win32')('passes literal workspace paths and cold-start settings to Electron', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-app-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const bundle = join(root, "Harness ' $(false).app")
  const binary = join(bundle, 'Contents', 'MacOS', 'Electron')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$DSH_HOME" "$DSH_DESKTOP_DEV_APP" "$DSH_DESKTOP_OPEN_DEVTOOLS" "$@"\n', { mode: 0o755 })
  const launcher = join(root, 'launcher')
  const home = join(root, "home ' $(false)")
  writeFileSync(launcher, developmentLauncher({ electron: binary, appRoot: root, directory: root,
    home, userData: join(root, 'browser data'), mainPort: 9229, rendererPort: 9222, hostPort: 9230, openDevtools: '0' }, bundle))
  const result = execFileSync('/bin/sh', [launcher, '--test-launch-argument'], { encoding: 'utf8' })
  expect(result.trimEnd().split('\n')).toEqual([home, '1', '0', '--inspect=127.0.0.1:9229',
    '--remote-debugging-port=9222', `--user-data-dir=${join(root, 'browser data')}`, root, '--test-launch-argument'])
})

it('names the bundle icon and the per-workspace identity in the development plist', () => {
  const values = developmentPlistValues(options)
  // The bundle starts as a copy of Electron.app, so the plist has to point at the icon written for it.
  expect(values.CFBundleIconFile).toBe('AppIcon.icns')
  expect(values.CFBundleExecutable).toBe('HarnessDev')
  expect(values.CFBundleIdentifier).toMatch(/^com\.deepseek\.harness\.dev\.[0-9a-f]{12}$/u)
  expect(values.CFBundleURLTypes).toEqual([
    { CFBundleURLName: 'DeepSeek Harness', CFBundleURLSchemes: ['dsh'], CFBundleTypeRole: 'Viewer' },
  ])
})

it.skipIf(process.platform !== 'darwin')('builds the bundle icon from the exported application icon', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-icon-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const resources = join(root, 'Harness Dev.app', 'Contents', 'Resources')
  mkdirSync(resources, { recursive: true })
  installDevelopmentAppIcon(join(root, 'Harness Dev.app'), fileURLToPath(new URL('../resources/icon-macos.png', import.meta.url)))
  const icns = readFileSync(join(resources, 'AppIcon.icns'))
  expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
  expect(icns.length).toBeGreaterThan(10_000)
  // The iconset is an intermediate of iconutil, not something the bundle ships.
  expect(existsSync(join(resources, 'AppIcon.iconset'))).toBe(false)
})

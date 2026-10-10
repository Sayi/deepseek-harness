#!/usr/bin/env node
/**
 * 用 curl 预取 primary runtime 的全部锁定产物，填充 DSH 的下载缓存。
 *
 * 为什么需要它
 *   scripts/primary-runtime/prepare.ts 用 Node 的全局 fetch（undici）下载，而
 *   undici 有一个脚本从未配置、也无法从外部调大的 10 秒连接超时。在不稳定的
 *   网络上这会间歇性抛出 UND_ERR_CONNECT_TIMEOUT（"fetch failed"），
 *   即使把 DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS 调到 30 分钟也无济于事——那是
 *   整个请求的时限，不是连接时限。curl 在同一网络上稳定可用。
 *
 * 为什么用 curl 填充缓存是安全的
 *   缓存文件以内容的 sha256 命名，prepare.ts 读取后仍会重新校验哈希，不匹配就
 *   删除并报错。所以本脚本只是把同样的字节搬到同样的位置，绕过不稳定的网络栈，
 *   不放宽任何完整性校验。
 *
 * 用法
 *   node prefetch-primary-runtime.mjs --list    # 只列出将要下载的产物
 *   node prefetch-primary-runtime.mjs           # 预取并校验
 *
 * 已存在且哈希正确的文件会被跳过；已完成的产物不会重复下载。
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname)
const LOCK = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts/primary-runtime/lock.json'), 'utf8'))
const CACHE_DIR = join(REPO_ROOT, 'apps/desktop/.desktop-build/downloads')

/** 把当前平台映射到 lock.json 的 target 名称。 */
function currentTarget() {
  const os = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
  const name = `${os}-${process.arch}`
  if (!(name in LOCK.targets)) {
    throw new Error(`未知目标 ${name}；lock.json 只声明了 ${Object.keys(LOCK.targets).join(', ')}`)
  }
  return name
}

/** 组装当前目标需要下载的全部产物（URL + sha256 + 人读标签）。 */
function artifacts(target) {
  const entry = LOCK.targets[target]
  const pythonFilename = `cpython-${LOCK.pythonVersion}+${LOCK.pythonRelease}-${entry.pythonTarget}-install_only_stripped.tar.gz`
  return [
    {
      label: `node v${LOCK.nodeVersion}`,
      url: `https://nodejs.org/dist/v${LOCK.nodeVersion}/node-v${LOCK.nodeVersion}-${entry.nodeArchive}`,
      sha256: entry.nodeSha256,
    },
    {
      label: `python ${LOCK.pythonVersion}`,
      url: `https://github.com/astral-sh/python-build-standalone/releases/download/${LOCK.pythonRelease}/${encodeURIComponent(pythonFilename)}`,
      sha256: entry.pythonSha256,
    },
    ...[...entry.wheels, ...LOCK.wheels].map(wheel => ({
      label: wheel.url.split('/').pop(),
      url: wheel.url,
      sha256: wheel.sha256,
    })),
  ]
}

/** 计算文件内容的 sha256，用于校验。 */
function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 用 curl 下载到 `<destination>.part`，校验通过后再重命名到位。
 * 失败时保留 `.part` 以便下次续传；服务器不支持续传则从头重来一次。
 * @returns 下载后的字节数。
 */
async function downloadWithCurl(url, destination) {
  const part = `${destination}.part`
  const common = ['-fL', '--retry', '5', '--retry-delay', '2', '--retry-all-errors',
    '--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '180']
  const runCurl = extra => new Promise((resolvePromise, reject) => {
    const child = spawn('curl', [...common, ...extra, '-o', part, url], { stdio: ['ignore', 'ignore', 'ignore'] })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`curl 退出码 ${String(code)}`)))
  })
  try {
    await runCurl(['-C', '-'])
  } catch (error) {
    // 续传被拒（服务器不支持 Range）或 .part 损坏时，丢弃残留从头再来一次。
    rmSync(part, { force: true })
    try {
      await runCurl([])
    } catch {
      throw error
    }
  }
  const digest = sha256Of(part)
  if (digest !== destination.split('/').pop()) {
    rmSync(part, { force: true })
    throw new Error(`校验失败：期望 ${destination.split('/').pop()}，实际 ${digest}`)
  }
  renameSync(part, destination)
  return statSync(destination).size
}

const target = currentTarget()
const list = artifacts(target)
if (process.argv.includes('--list')) {
  console.log(`目标 ${target}，共 ${list.length} 个产物，缓存目录 ${CACHE_DIR}`)
  for (const item of list) console.log(`  ${item.sha256}  ${item.label}`)
  process.exit(0)
}

mkdirSync(CACHE_DIR, { recursive: true })
console.log(`prefetch: 目标 ${target}，${list.length} 个产物`)
console.log(`prefetch: 缓存 ${CACHE_DIR}`)

let downloaded = 0
let reused = 0
const failures = []
for (const [index, item] of list.entries()) {
  const destination = join(CACHE_DIR, item.sha256)
  const position = `[${String(index + 1)}/${String(list.length)}]`
  if (existsSync(destination) && sha256Of(destination) === item.sha256) {
    reused++
    console.log(`${position} 已缓存 ${item.label}`)
    continue
  }
  try {
    const bytes = await downloadWithCurl(item.url, destination)
    downloaded++
    console.log(`${position} 已下载 ${item.label}  ${(bytes / 1048576).toFixed(1)} MB`)
  } catch (error) {
    failures.push(item.label)
    console.error(`${position} 失败   ${item.label}  ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(`prefetch: 新下载 ${String(downloaded)} 个，复用 ${String(reused)} 个，失败 ${String(failures.length)} 个`)
if (failures.length > 0) {
  console.error('prefetch: 重跑本脚本即可续传；失败多次再考虑代理。')
  process.exitCode = 1
}

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const STATE_DIRNAME = '.lawcase-plugin'

/**
 * 解析案件根目录。优先级：环境变量 > config.root > null（完全由 case 参数决定）
 * 不猜 process.cwd()——宿主进程的 cwd 是应用目录，猜它必错。
 */
export function resolveRoot(config = {}, pkgRoot = '') {
  const fromEnv = process.env.LAWCASE_ROOT
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim())
  const raw = config && typeof config.root === 'string' ? config.root.trim() : ''
  if (raw && raw !== 'auto') return path.resolve(raw)
  // auto：取插件包的同级 cases/（插件装在 lawdsh/ 下，案件也放 lawdsh/cases/）。
  // 不用 process.cwd()——宿主进程的 cwd 是应用目录，猜它必错。
  if (pkgRoot) {
    const sibling = path.join(path.dirname(pkgRoot), 'cases')
    if (fs.existsSync(sibling)) return sibling
  }
  return null
}

/**
 * 状态/日志目录
 * - 有案件根：<root>/.lawcase-plugin
 * - 无案件根：插件包内 .lawcase-plugin（随工作区同步、必然可写）
 * 不回落到 ~：会话沙箱只放行工作区，写 home 会 EPERM。
 */
// 插件自身的日志/自检状态，永远跟着插件包走（pkgRoot 下 .lawcase-plugin），
// 不落到案件根：案件根只放案件的三件套台账，混进插件日志会污染案卷。
export function stateDir(root, pkgRoot) {
  const base = pkgRoot || process.env.LAWCASE_STATE || process.cwd()
  return path.join(base, STATE_DIRNAME)
}

export function appendLog(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n', 'utf8')
    return true
  } catch (e) {
    return false
  }
}

/** 真写一个临时文件再删，比 access(W_OK) 可信 */
export function probeWritable(dir) {
  const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(probe, 'ok', 'utf8')
    const back = fs.readFileSync(probe, 'utf8')
    fs.unlinkSync(probe)
    return { ok: back === 'ok', dir }
  } catch (e) {
    try { fs.existsSync(probe) && fs.unlinkSync(probe) } catch (_) {}
    return { ok: false, dir, error: String((e && e.message) || e) }
  }
}

export { STATE_DIRNAME, os }

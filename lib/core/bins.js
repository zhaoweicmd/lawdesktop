// 外部可执行文件的定位：不把任何一台机器的绝对路径写死在代码里
//（上架要求：包内不得含本机绝对路径）。
//
// 顺序：环境变量 > PATH > 常见安装目录。
// 换机器、换 node 版本管理器都不会失效。

import fs from 'node:fs'
import path from 'node:path'

// 常见安装目录：按平台分开。
// Windows 上 `/usr/bin` 这类 POSIX 路径根本不存在，混在一起只会白跑几十次 existsSync。
const COMMON_DIRS_POSIX = [
  '/opt/homebrew/bin', // Apple Silicon Homebrew
  '/usr/local/bin', // Intel Homebrew / 手工安装
  '/usr/bin',
]
const COMMON_DIRS_WIN = [
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs') : '',
  process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs') : '',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '',
  process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : '',
].filter(Boolean)

const IS_WIN = process.platform === 'win32'
const COMMON_DIRS = IS_WIN ? COMMON_DIRS_WIN : COMMON_DIRS_POSIX

/**
 * Windows 上可执行文件带扩展名，且 `fs.access(X_OK)` 在 Windows 上恒为真；
 * 反过来，不带扩展名的 `python3` 在 Windows 上通常叫 `python.exe`。
 * 这里按平台补齐候选名，别让同一份代码在 Win 上「找不到工具」。
 */
function candidatesFor(name) {
  if (!IS_WIN) return [name]
  const out = [name]
  if (!path.extname(name)) {
    const pathext = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    for (const ext of pathext) out.push(name + ext.toLowerCase(), name + ext.toUpperCase())
    // python3 在 Windows 上一般就是 python.exe
    if (name === 'python3') out.push('python.exe')
  }
  return out
}

/** 在 PATH 与常见目录里找可执行文件；找到返回绝对路径，否则 null */
export function which(name, { envName = '', extraDirs = [] } = {}) {
  if (!name) return null

  const fromEnv = envName && process.env[envName] ? String(process.env[envName]).trim() : ''
  if (fromEnv) {
    try {
      if (fs.existsSync(fromEnv)) return fromEnv
    } catch (e) {
      /* 继续找 */
    }
  }

  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    ...extraDirs,
    ...COMMON_DIRS,
  ].filter(Boolean)

  const seen = new Set()
  const names = candidatesFor(name)
  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    for (const nm of names) {
      const candidate = path.join(dir, nm)
      try {
        if (!fs.existsSync(candidate)) continue
        // Windows 上 X_OK 判断不可靠（对任何存在的文件都通过），
        // 直接用存在性；POSIX 仍检查可执行位，避免把同名的普通文件当命令。
        if (!IS_WIN) fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch (e) {
        /* 继续找 */
      }
    }
  }
  return null
}

// MinerU 4.x（mineru-kit）调用层
//
// 3.x 那一套（`mineru -p … -o … --api-url …` + 常驻服务 + 带页码锚点的 markdown）
// 在 4.0 已经不存在了，所以这里是重写而不是修补：
//   · 入口：`mineru-kit parse`，进程内解析，不建库、不需要守护进程；
//   · 输出：`--format middle_json`（协议 docvortex.middle 2.0），页序即源 PDF 页序；
//   · 区间：`--pages 4-6`（1-based、含两端），页号由引擎保留，我们只做断言。
//
// 为什么不走 `mineru parse`（doclib 路径）：它会把正文写进全局库 ~/.mineru/doclib.db，
// 而 `mineru search` 能跨文档检索——另一个案件的材料会被搜出来。案件隔离压过那点缓存便利。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export const TIERS = ['flash', 'basic', 'standard', 'advanced']
export const DEFAULT_TIER = 'basic'

export class MineruError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'MineruError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * 找 mineru-kit：环境变量优先 → PATH → ~/.local/bin → ~/opt/mineru-4.x/.venv/bin。
 * 不假设用户手动建软链：实测 ~/.local/bin 里只有 `mineru`，没有 `mineru-kit`。
 */
export function findMineruKit() {
  const cands = []
  if (process.env.LAWCASE_MINERU_KIT) cands.push(process.env.LAWCASE_MINERU_KIT)
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (dir) cands.push(path.join(dir, 'mineru-kit'))
  }
  cands.push(path.join(os.homedir(), '.local', 'bin', 'mineru-kit'))
  try {
    const opt = path.join(os.homedir(), 'opt')
    const versions = fs
      .readdirSync(opt)
      .filter((name) => /^mineru-\d/.test(name))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .reverse() // 新版本优先
    for (const v of versions) cands.push(path.join(opt, v, '.venv', 'bin', 'mineru-kit'))
  } catch {
    /* 没有 ~/opt 就跳过 */
  }
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c
    } catch {
      /* 忽略无权限的候选 */
    }
  }
  return null
}

/** 从路径里抠版本号（…/mineru-4.0.12/.venv/bin/mineru-kit → 4.0.12），拿不到就返回 '' */
export function kitVersionFromPath(bin) {
  const m = String(bin || '').match(/mineru-(\d+\.\d+(?:\.\d+)?)/)
  return m ? m[1] : ''
}

/** 4.0 的结构化错误码；拿不到就按 stderr 归类，绝不把整段 stderr 丢给用户 */
export function classifyMineruError(err, stderr = '') {
  const text = `${stderr}\n${err && err.message ? err.message : ''}`
  if (err && (err.killed || /timed out|ETIMEDOUT/i.test(text))) return 'parse_timeout'
  if (/quality_tier_unavailable|no_engine|tier_mismatch/i.test(text)) return 'quality_tier_unavailable'
  if (/page_range_invalid|页码范围/i.test(text)) return 'page_range_invalid'
  if (/parse_oom|MemoryError|out of memory|out of vram/i.test(text)) return 'parse_oom'
  if (/file_encrypted|password/i.test(text)) return 'file_encrypted'
  if (/file_corrupted/i.test(text)) return 'file_corrupted'
  if (/No module named|command not found|ENOENT|Operation not permitted|Permission denied/i.test(text)) {
    return 'engine_unavailable'
  }
  if (/No such file|cannot find the path|file_not_found/i.test(text)) return 'file_not_found'
  return 'parse_failed'
}

/** stderr 里最后两行有信息量的内容，用来给人看 */
function tailLine(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  return lines.slice(-2).join(' ')
}

/**
 * 解析一个页区间。
 * @returns {Promise<{middle, path, ms, tier, kit, version}>}
 */
export async function parsePdfWithMineru(absPath, {
  from,
  to,
  tier = DEFAULT_TIER,
  outPath,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  if (!TIERS.includes(tier)) {
    throw new MineruError('invalid_request', `档位「${tier}」不认识，可选：${TIERS.join(' / ')}`)
  }
  const bin = findMineruKit()
  if (!bin) {
    throw new MineruError(
      'engine_unavailable',
      '找不到 mineru-kit。它装在 ~/opt/mineru-*/.venv/bin 下，或用 LAWCASE_MINERU_KIT 指到该可执行文件',
    )
  }

  const out = outPath || path.join(os.tmpdir(), `lawcase-mineru-${process.pid}-${Date.now()}.json`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const args = ['parse', absPath, '-o', out, '--format', 'middle_json', '--tier', tier]
  if (from || to) {
    const a = Math.max(1, Number(from) || 1)
    const b = Number(to) || 0
    args.push('--pages', b >= a ? `${a}-${b}` : String(a))
  }

  const t0 = Date.now()
  let stderr = ''
  try {
    const r = await execFileP(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
    })
    stderr = String(r.stderr || '')
  } catch (e) {
    stderr = String((e && e.stderr) || '')
    const code = classifyMineruError(e, stderr)
    const msg = tailLine(stderr) || String((e && e.message) || e)
    throw new MineruError(code, `MinerU ${tier} 解析失败（${code}）：${msg}`, {
      stderr,
      ms: Date.now() - t0,
      tier,
      pages: from || to ? `${from || 1}-${to || ''}` : 'all',
    })
  }

  const ms = Date.now() - t0
  let middle
  try {
    middle = JSON.parse(fs.readFileSync(out, 'utf8'))
  } catch {
    throw new MineruError('parse_failed', `MinerU 没产出可读的 middle_json：${out}`, { stderr, ms, tier })
  }
  return { middle, path: out, ms, tier, kit: bin, version: kitVersionFromPath(bin) }
}

export function mineruAvailable() {
  return findMineruKit() !== null
}

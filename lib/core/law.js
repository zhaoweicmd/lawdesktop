import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { casePaths, readJson, readJsonl, appendJsonl, mutateCase, nowIso, log } from './store.js'
import { tryParseJson } from './clijson.js'

export const SOURCE_WEIGHT = { pkulaw: 100, official: 90, gazette: 80, manual: 40 }
export const SOURCE_LABEL = {
  pkulaw: '北大法宝 MCP',
  official: '官方数据库/法规原文页',
  gazette: '公报/纸质正式文本',
  manual: '手工录入（未核）',
}

const CN = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const UNIT = { 十: 10, 百: 100, 千: 1000 }

/** 条号规范化：第五百零九条 / 第509条 / 509 → 509 */
export function articleNumber(text) {
  const s = String(text || '').replace(/\s/g, '')
  const arabic = /第?(\d+)条?/.exec(s)
  if (arabic && /^\D*\d/.test(s)) return Number(arabic[1])
  // 「第五百零九条之一」这类附属条文，法宝的写法是 509.1；这里只在调用侧处理
  const body = s.replace(/^第/, '').replace(/条.*$/, '').replace(/之[一二三四五六七八九十]+$/, '')
  let total = 0
  let section = 0
  for (const ch of body) {
    if (ch in CN) section = CN[ch]
    else if (ch in UNIT) {
      total += (section || 1) * UNIT[ch]
      section = 0
    }
  }
  return total + section || null
}

/**
 * 条号 → 法宝的 tiao_num。
 * 法宝约定：2 = 第二条，2.1 = 第二条之一，2.2 = 第二条之二。
 */
export function toTiaoNum(article, fallbackNum) {
  const raw = String(article || '').replace(/\s/g, '')
  const sub = /之([一二三四五六七八九十]+)$/.exec(raw)
  const base = fallbackNum || articleNumber(raw)
  if (!sub) return String(base)
  const d = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const n = d[sub[1]]
  return n ? `${base}.${n}` : String(base)
}

/** 从 MCP 返回的任意结构里扒出可读文本 */
function collectText(v, out = [], depth = 0) {
  if (depth > 6 || v == null) return out
  if (typeof v === 'string') {
    if (v.trim().length > 2) out.push(v)
    return out
  }
  if (Array.isArray(v)) {
    for (const x of v) collectText(x, out, depth + 1)
    return out
  }
  if (typeof v === 'object') {
    for (const k of ['text', 'content', 'markdown', 'digest', 'result', 'data', 'structuredContent', 'value']) {
      if (k in v) collectText(v[k], out, depth + 1)
    }
  }
  return out
}

/** 调用北大法宝 MCP CLI。命令不存在/未登录会抛可读错误。
 *  spawn 用数组参数，不经 shell——不拼接任何用户输入。 */
export function runPkulaw(args, { command = 'pkulaw-mcp', timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message || '').slice(0, 400)
        if (err.code === 'ENOENT') {
          return reject(new Error(`找不到命令 ${command}：北大法宝 MCP 未安装（npm i -g @pkulaw/mcp-cli），或在配置里给 lawVerify.command 绝对路径`))
        }
        if (err.killed) return reject(new Error(`北大法宝 MCP 超时（>${timeoutMs}ms）：检查网络或 access token`))
        return reject(new Error(`北大法宝 MCP 调用失败：${detail}`))
      }
      const parsed = tryParseJson(stdout)
      if (parsed) resolve(parsed)
      else resolve({ raw: String(stdout).slice(0, 4000), stdout: String(stdout).slice(0, 4000) })
    })
  })
}

/** 探测北大法宝是否可用（装了没 / token 配了没） */
export async function probePkulaw({ command = 'pkulaw-mcp', timeoutMs = 12000 } = {}) {
  // 配置文件的 authorization 是否真的配好了。
  // 「✓ authorization: 已写入配置文件」这句不足以说明问题——实测遇到过写入的是
  // 空 token（长度 6，只剩 "Bearer"）或缺前缀（长度 36，只有 token），check 照样打勾，
  // 但所有查询都会报「认证失败」。所以这里自己看一眼长度和前缀。
  const cfgPath = path.join(os.homedir(), '.pkulaw/mcp/config.json')
  let cfgNote = null
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    const auth = String(cfg.authorization || '')
    if (!auth) cfgNote = '配置文件里没有 authorization'
    else if (!auth.startsWith('Bearer ')) cfgNote = `authorization 缺少「Bearer 」前缀（当前长度 ${auth.length}）`
    else if (auth.length < 20) cfgNote = `authorization 长度只有 ${auth.length}，token 可能没写进去`
    if (cfgNote) {
      return {
        ok: false,
        command,
        configured: false,
        reason: `${cfgNote}。重跑：pkulaw-mcp init --authorization "Bearer <Token>"（注意 Bearer 后有空格，整段用双引号包住）`,
      }
    }
  } catch (e) {
    return { ok: false, command, configured: false, reason: `读不到配置文件 ${cfgPath}：${e.message}` }
  }

  try {
    await runPkulaw(['check'], { command, timeoutMs })
    return { ok: true, command, configured: true, reason: '配置正常' }
  } catch (e) {
    return { ok: false, command, configured: null, reason: String(e.message || e) }
  }
}

function norm(s) {
  return String(s || '').replace(/[\s\u3000]/g, '').replace(/[，。；：、,.;:]/g, '')
}

/** 登记一条法条引用 */
export function addLaw({ case: caseDirRaw, title, article, quote, source = 'manual', url, effectiveFrom, repealedAt, note }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}`)
  const t = String(title || '').trim()
  const a = String(article || '').trim()
  if (!t) throw new Error('法规名称必填（如「中华人民共和国民法典」）')
  if (!a) throw new Error('条号必填（如「第五百零九条」）')
  if (!(source in SOURCE_WEIGHT)) throw new Error(`来源类型只能是：${Object.keys(SOURCE_WEIGHT).join(' / ')}`)
  const q = String(quote || '').trim()
  if (q && q.length < 8) throw new Error('条文原文过短（<8 字），请贴完整条文')

  const existing = readJsonl(cp.laws).filter((x) => !x.__broken)
  const dup = existing.find((x) => x.title === t && articleNumber(x.article) === articleNumber(a))
  if (dup) throw new Error(`${t}${a} 已登记为 ${dup.id}，要改请用 lc_law_amend`)

  let out = null
  mutateCase(dir, (d) => {
    d.lawsSeq = (d.lawsSeq || 0) + 1
    out = {
      id: 'L' + d.lawsSeq,
      title: t,
      article: a,
      articleNum: articleNumber(a),
      quote: q || undefined,
      source,
      sourceLabel: SOURCE_LABEL[source],
      url: url || undefined,
      effectiveFrom: effectiveFrom || undefined,
      repealedAt: repealedAt || undefined,
      checkedAt: nowIso(),
      status: q ? 'local-ok' : 'unverified',
      note: note || undefined,
      createdAt: nowIso(),
    }
    return d
  })
  appendJsonl(cp.laws, out)
  log(dir, `law-add`, { id: out.id, title: t, article: a, source })
  return {
    ok: true, law: out,
    summary: `已登记 ${out.id}｜${t}${a}｜来源：${SOURCE_LABEL[source]}${q ? '（含原文）' : '（无原文，未回源）'}`,
  }
}

export function loadLaws(dir) {
  const cp = casePaths(dir)
  const raw = readJsonl(cp.laws).filter((x) => !x.__broken)
  const byId = new Map()
  for (const x of raw) {
    if (!x.id) continue
    byId.set(x.id, { ...(byId.get(x.id) || {}), ...x })
  }
  return [...byId.values()]
}

/** 本地规则核验（不联网）：能判的都判掉，判不了的留 warn */
export function localVerdict(law, { maxAgeDays = 30 } = {}) {
  const items = []
  if (!law.quote) items.push({ level: 'warn', msg: `${law.id} 只有条号没有条文原文，名义上「有来源」实际无法核对` })
  if (law.repealedAt) items.push({ level: 'fail', msg: `${law.id} ${law.title}${law.article} 已于 ${law.repealedAt} 废止` })
  if (SOURCE_WEIGHT[law.source] <= 40) items.push({ level: 'warn', msg: `${law.id} 来源为「${SOURCE_LABEL[law.source]}」，未经权威库核对` })
  const age = law.checkedAt ? (Date.now() - Date.parse(law.checkedAt)) / 86400000 : null
  if (age != null && age > maxAgeDays) items.push({ level: 'warn', msg: `${law.id} 上次核验在 ${Math.round(age)} 天前，超过 ${maxAgeDays} 天需重新核对` })
  const level = items.some((i) => i.level === 'fail') ? 'fail' : items.length ? 'warn' : 'pass'
  return { level, items }
}

/** 扒出 tools 列表里的工具名（结构未知，尽量容错） */
export function extractToolNames(payload) {
  const out = []
  const walk = (v, d = 0) => {
    if (d > 5 || v == null) return
    if (Array.isArray(v)) return v.forEach((x) => walk(x, d + 1))
    if (typeof v === 'object') {
      if (typeof v.name === 'string' && v.name) out.push(v.name)
      for (const k of ['tools', 'result', 'data', 'structuredContent', 'content']) if (k in v) walk(v[k], d + 1)
    }
  }
  walk(payload)
  return [...new Set(out)]
}

/** 列出某 server 下真实可用的工具名（需要已配置 token） */
export async function listPkulawTools({ server = 'fatiao', command = 'pkulaw-mcp', timeoutMs = 25000 } = {}) {
  const payload = await runPkulaw(['tools', server], { command, timeoutMs })
  const fromStruct = extractToolNames(payload)
  if (fromStruct.length) return fromStruct
  const text = payload.raw || String(payload.stdout || '') || JSON.stringify(payload)
  return [...new Set(text.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) || [])]
}

/** 用北大法宝核对一条法条：取权威原文，与登记原文比对 */
export async function verifyLawWithMcp({ case: caseDirRaw, id, command = 'pkulaw-mcp', tool = 'get_law_item_content', timeoutMs = 25000 }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const laws = loadLaws(dir)
  const law = laws.find((x) => x.id === String(id).toUpperCase())
  if (!law) throw new Error(`没有 ${id} 这条法条记录`)
  const num = toTiaoNum(law.article, law.articleNum)
  let payload
  try {
    payload = await runPkulaw(['fatiao', tool, '--title', law.title, '--tiao_num', String(num), '--json'], { command, timeoutMs })
  } catch (e) {
    if (!/tool|not found|未知|不存在/i.test(String(e.message))) throw e
    let names = []
    try {
      names = await listPkulawTools({ command, timeoutMs })
    } catch {}
    throw new Error(
      `北大法宝服务 fatiao 上没有工具「${tool}」。` +
        (names.length ? `该服务实际可用：${names.join('、')}。用 --tool 指定正确的一个。` : '先跑 lc_law_probe / law-tools 列出真实工具名。') +
        `原始错误：${e.message}`
    )
  }
  // 法宝真实返回：{ Message: '成功', Data: { FullText, Url, TimelinessDic, ImplementDate, ... } }
  const data = payload && payload.Data ? payload.Data : null
  if (!data) {
    const texts = collectText(payload)
    const alt = texts.sort((a, b) => b.length - a.length)[0] || ''
    if (!alt) {
      throw new Error(
        `北大法宝没有返回该条内容：${law.title}${law.article}（可能是法规名不精确，或该条不存在）。` +
          `原始返回：${JSON.stringify(payload).slice(0, 200)}`,
      )
    }
    return finishVerify({ law, dir, cp, official: alt, data: null })
  }
  const message = String(payload.Message || '')
  if (message && message !== '成功') throw new Error(`北大法宝返回：${message}`)
  const official = String(data.FullText || '').trim()
  if (!official) {
    throw new Error(`北大法宝返回成功但 FullText 为空：${law.title}${law.article}`)
  }
  return finishVerify({ law, dir, cp, official, data })
}

/** 比对与回填：官方效力状态、来源链接都从法宝取，不靠人工填 */
function finishVerify({ law, dir, cp, official, data }) {
  const mine = norm(law.quote)
  const theirs = norm(official)
  let status
  let detail
  if (!mine) {
    status = 'mcp-verified'
    detail = '北大法宝取到原文，已回填'
  } else if (theirs.includes(mine) || mine.includes(theirs)) {
    status = 'mcp-verified'
    detail = '登记原文与北大法宝一致'
  } else {
    status = 'mcp-mismatch'
    detail = '登记原文与北大法宝不一致'
  }
  const timeliness = data && Array.isArray(data.TimelinessDic) ? data.TimelinessDic.join('/') : ''
  const url = data && data.Url ? String(data.Url).replace(/^\[[^\]]*\]\(([^)]+)\)$/, '$1') : undefined
  const patch = {
    id: law.id,
    status,
    provider: 'pkulaw',
    checkedAt: nowIso(),
    quote: !mine ? official.slice(0, 2000) : law.quote,
    officialQuote: official.slice(0, 2000),
    mcpDetail: detail,
    timeliness: timeliness || undefined,
    url: url || law.url,
    implementDate: (data && data.ImplementDate) || undefined,
  }
  appendJsonl(cp.laws, patch)
  log(dir, 'law-verify-mcp', { id: law.id, status, timeliness })
  const warn = timeliness && !/现行有效/.test(timeliness) ? `｜效力状态：${timeliness}（需人工确认能否引用）` : ''
  return {
    ok: status !== 'mcp-mismatch',
    law: { ...law, ...patch },
    status,
    detail,
    timeliness: timeliness || null,
    official: official.slice(0, 300),
    registered: (law.quote || '').slice(0, 300),
    summary:
      `${law.id} ${law.title}${law.article}：${detail}` +
      (timeliness ? `｜法宝标注：${timeliness}` : '') +
      warn +
      (status === 'mcp-mismatch' ? ' —— 必须人工看过再定' : ''),
  }
}

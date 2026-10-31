// 写入审计：案件侧留证据，插件侧留可查的操作流水。
//
// 为什么要有这一份（2026-10-31 实测发现）：
//   案件里是有 <.lawcase/log.jsonl> 的，但插件侧 <plugin.log.jsonl> 1464 行
//   **全是宿主挂载记录**（client-mount ×1368），零业务操作。结果是——
//   谁在什么时候改了某条事实的出处、谁把一条风险条款标成「无需审查」，
//   在插件层查不到；一旦出了争议，只有当事人自己知道自己点过什么。
//
// 设计上的三条克制：
//   1. **一个产出，两处落点**：调用点仍然只写一次 log(...)，不许出现"有的操作记了、有的没记"；
//   2. **审计失败不拖垮主流程**：写不进去就静默跳过（案件侧日志才是主证据）；
//   3. **按天分片 + 自动清理**：审计流水会比案件活得更久，不能无限长大。

import fs from 'node:fs'
import path from 'node:path'

/** 落盘字段顺序固定，方便人肉 grep 与外部脚本解析 */
const FIELDS = ['ts', 'op', 'case', 'caseId', 'session', 'summary', 'previous']

/** 单条摘要上限：审计记的是"做了什么"，不是"全文" */
const SUMMARY_MAX = 600

const DAY_MS = 24 * 60 * 60 * 1000

/** 审计目录：<pkgRoot>/.lawcase-plugin/audit */
export function auditDir(pkgRoot) {
  return path.join(pkgRoot || process.cwd(), '.lawcase-plugin', 'audit')
}

/** 按天分片：audit-YYYY-MM-DD.jsonl */
export function auditFile(pkgRoot, date = new Date()) {
  const d = new Date(date)
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return path.join(auditDir(pkgRoot), `audit-${day}.jsonl`)
}

/** 把任意对象压成一行摘要：审计要能读，但不能变成第二份台账 */
export function concise(value, max = SUMMARY_MAX) {
  let s = ''
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value)
  } catch (e) {
    s = String(value)
  }
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 案件定位：只记目录名与 caseId，不把绝对路径写进插件日志 */
function caseIdentity(caseDir) {
  if (!caseDir) return { case: null, caseId: null }
  const dir = String(caseDir)
  let caseId = null
  try {
    const raw = fs.readFileSync(path.join(dir, '.lawcase', 'case.json'), 'utf8')
    const c = JSON.parse(raw)
    caseId = (c && c.caseId) || null
  } catch (e) {
    caseId = null
  }
  return { case: path.basename(dir), caseId }
}

/**
 * 写一条审计。
 *
 * @param {object} p
 * @param {string} p.pkgRoot   插件包根（决定审计目录；CHILD 进程里也用同一个）
 * @param {object} p.record    已经成形的日志记录（含 op/ts）
 * @param {string} [p.caseDir] 案件目录（只取目录名与 caseId 落盘）
 * @param {string} [p.sessionId] 会话 id（谁干的）
 * @param {object} [p.context] 除 op/ts 外的业务字段（会被 concise 压成 summary）
 * @param {string} [p.previous] 上一次操作摘要（给「上次动作」用，由调用方传入）
 * @returns {boolean} 是否真的写进去了
 */
export function writeAudit({ pkgRoot, record, caseDir, sessionId, context, previous } = {}) {
  const rec = record && typeof record === 'object' ? record : {}
  const op = rec.op ? String(rec.op) : '(unknown)'
  const id = caseIdentity(caseDir)

  const row = {
    ts: rec.ts || new Date().toISOString(),
    op,
    case: id.case,
    caseId: id.caseId,
    session: sessionId || null,
    summary: concise(context === undefined ? stripMeta(rec) : context),
    previous: previous || null,
  }

  try {
    const file = auditFile(pkgRoot, new Date(row.ts))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8')
    return true
  } catch (e) {
    return false
  }
}

/** 去掉 ts/op 之后剩下的业务字段（这也是 summary 的默认来源） */
function stripMeta(rec) {
  const out = {}
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'ts' || k === 'op') continue
    out[k] = v
  }
  return Object.keys(out).length ? out : null
}

/** 读某天（默认今天）的审计，按写入顺序 */
export function readAudit(pkgRoot, date = new Date()) {
  const file = auditFile(pkgRoot, date)
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch (e) {
      out.push({ __broken: true, raw: t.slice(0, 200) })
    }
  }
  return out
}

/**
 * 最近一条**业务**审计（跳过挂载类噪音）。
 * 「上次动作」要的是人的操作，不是宿主又加载了一次前端。
 */
export function lastAudit(pkgRoot, { withinDays = 14, date = new Date() } = {}) {
  const d = new Date(date)
  for (let i = 0; i < withinDays; i += 1) {
    const rows = readAudit(pkgRoot, d)
    for (let j = rows.length - 1; j >= 0; j -= 1) {
      const r = rows[j]
      if (!r || r.__broken || !r.op) continue
      if (NOISE.has(r.op)) continue
      return r
    }
    d.setTime(d.getTime() - DAY_MS)
  }
  return null
}

/** 这些 op 是宿主生命周期噪音，不算「人的动作」 */
const NOISE = new Set([
  'client-mount',
  'plugin-ready',
  'tool-register',
  'schema-selfcheck',
  'tools-service-probe',
  'api-route',
  'api-mount',
])

/** 清理 N 天之前的审计分片；返回删掉的份数 */
export function pruneAudit(pkgRoot, { keepDays = 30, date = new Date() } = {}) {
  const dir = auditDir(pkgRoot)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    return 0
  }
  const cutoff = new Date(date).getTime() - keepDays * DAY_MS
  let removed = 0
  for (const n of names) {
    const m = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(n)
    if (!m) continue
    const t = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime()
    if (!Number.isFinite(t) || t >= cutoff) continue
    try {
      fs.unlinkSync(path.join(dir, n))
      removed += 1
    } catch (e) {
      // 删不掉就算了，不能因为清理失败影响主流程
    }
  }
  return removed
}

export { FIELDS }

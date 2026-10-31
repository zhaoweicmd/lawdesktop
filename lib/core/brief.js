// 开场简报：一句话回答「这个案子现在到哪了、卡在哪、谁刚动过」。
//
// 为什么单独做一份（2026-10-31）：
//   lc_case_next 回答的是「下一步调哪个工具」，很准，但是**给模型看的**：
//   1.5k 字的 JSON，人扫不出来，模型每轮也得重读一遍。
//   顶栏要的是另一件事：**时间维度 + 卡点 + 核准状态**，一句话能扫完。
//   两者同一份数据，两个出口 —— 别各自算一遍（那就会「两份数字打架」）。
//
// 判据取自对方工作台的硬规矩：
//   · 「上次动作」必须跳过硬性噪音（挂载/重载不算人的动作）
//   · 失败要说清差多少条、差哪条，不给一个 0/1
//   · 没东西可说就**不要出现**（空行会变成视觉噪音，最后没人看）

import fs from 'node:fs'
import path from 'node:path'

import { casePaths, readJson, readJsonl } from './store.js'
import { checkStatus, triState } from './checkoff.js'
import { lastAudit, readAudit } from './audit.js'

const DAY = 24 * 60 * 60 * 1000

/** 把 ISO 时间压成「10-31 14:20」——顶栏只有一行，不能放完整时间戳 */
export function shortTime(iso) {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
}

/** 相对时间：今天/昨天/3 天前 —— 比绝对时间更容易判断"这还新鲜吗" */
export function relDay(iso, now = new Date()) {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const d1 = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const days = Math.round((d0 - d1) / DAY)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return shortTime(iso).slice(0, 5)
}

/** 审计 op → 人话。审计是给机器查的，界面要说人话 */
const OP_LABEL = {
  'fact-add': '登记事实',
  'fact-amend': '修正事实出处',
  'fact-revoke': '作废事实',
  'finding-add': '登记结论',
  'note-add': '写下条款意见',
  'note-update': '修改条款意见',
  'note-delete': '作废条款意见',
  'review-open': '开了一轮对抗复盘',
  'review-attack': '提出攻击点',
  'review-reply': '回应攻击点',
  'review-verdict': '裁定攻击点',
  checkoff: '核对台账',
  'clause-ruling': '标记条款已审',
  'clause-ruling-revoke': '撤销条款判定',
  'clause-index': '索引合同条款',
  'material-scan': '扫描材料',
  'material-decide': '定版本',
  'material-parse': '解析材料',
  'material-parse-all': '批量解析材料',
  'proc-plan': '拆解工序',
  'proc-update': '推进工序',
  'law-add': '登记法条',
  'deliver': '打交付包',
  'deliver-refuse': '交付被拒',
  'contract-revise': '生成修订版合同',
  'contract-report': '生成审核意见表',
  'ai-review': 'AI 审核条款',
  verify: '跑五道验收',
  case_new: '建立案件',
  'material-scan': '扫描材料',
  'verify-waive': '验收放行',
  'ledger-fix': '修正台账',
}

/** 把审计行里最有信息量的那个字段挑出来，附在动作后面 */
function detailOf(row) {
  if (!row || !row.summary) return ''
  try {
    const s = typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary
    if (!s || typeof s !== 'object') return String(row.summary).slice(0, 30)
    for (const k of ['id', 'file', 'name', 'clause', 'kind', 'title', 'path', 'out', 'check']) {
      if (s[k]) return String(s[k]).slice(0, 28)
    }
    const first = Object.values(s)[0]
    return first === undefined ? '' : String(first).slice(0, 28)
  } catch (e) {
    return String(row.summary).slice(0, 30)
  }
}

/**
 * 读案件「上次动作」。优先插件审计（跨案件、带会话），
 * 审计里没有（新装/换机/老案件）时退回案件自己的 log.jsonl。
 */
export function lastAction(caseDir, { pkgRoot = '', now = new Date() } = {}) {
  const name = path.basename(String(caseDir || ''))
  if (pkgRoot && name) {
    const row = lastAudit(pkgRoot, { withinDays: 30, date: now })
    if (row && row.case === name) {
      return {
        op: row.op,
        label: OP_LABEL[row.op] || row.op,
        detail: detailOf(row),
        at: row.ts,
        when: relDay(row.ts, now),
        time: shortTime(row.ts),
        source: 'audit',
      }
    }
    // 审计里最近一条不是这个案：按天倒着找这个案自己的那条
    for (let i = 0; i < 30; i += 1) {
      const d = new Date(now.getTime() - i * DAY)
      const rows = readAudit(pkgRoot, d).filter((r) => r && !r.__broken && r.case === name && r.op !== 'client-mount')
      if (rows.length) {
        const r = rows[rows.length - 1]
        return {
          op: r.op,
          label: OP_LABEL[r.op] || r.op,
          detail: detailOf(r),
          at: r.ts,
          when: relDay(r.ts, now),
          time: shortTime(r.ts),
          source: 'audit',
        }
      }
    }
  }

  // 回退：案件自己的日志（老案件、审计刚上线时都能用）
  try {
    const cp = casePaths(String(caseDir))
    const rows = readJsonl(cp.log).filter((r) => r && !r.__broken && r.op)
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const r = rows[i]
      const op = String(r.op)
      // 建案与核对这类噪音不算「上次动作」：建案是几十天前的事，
      // 拿它当上次动作 ⇒ 顶栏永远显示「今天建立案件」，看不出线索。
      if (op === 'checkoff' || op === 'sink' || op === 'case_new') continue
      return {
        op,
        label: OP_LABEL[op] || op,
        detail: [r.id, r.file, r.kind].filter(Boolean).map(String).join(' ').slice(0, 28),
        at: r.ts,
        when: relDay(r.ts, now),
        time: shortTime(r.ts),
        source: 'case-log',
      }
    }
  } catch (e) {
    // 日志读不出来不该让简报整块失败
  }
  return null
}

/** 案情体量：决定「材料 56/56」这类数字，顶栏与页签共用一份 */
function countsOf(dir) {
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  const mats = readJson(cp.materials, null) || { files: [] }
  const files = Array.isArray(mats.files) ? mats.files : []
  const factById = new Map()
  for (const f of readJsonl(cp.facts)) {
    if (f.__broken || !f.id) continue
    factById.set(f.id, { ...(factById.get(f.id) || {}), ...f })
  }
  const facts = [...factById.values()].filter((f) => !f.__revoked)
  const findings = readJsonl(cp.findings).filter((r) => !r.__broken && !r.__revoked)
  const clausesRaw = readJson(cp.clauses, null)
  const clauseFiles = (clausesRaw && clausesRaw.files) || []
  const clauses = clauseFiles.reduce((n, f) => n + ((f && f.clauses) || []).length, 0)
  const parsedCache = path.join(cp.state, 'cache', 'parse')
  let parsed = 0
  try {
    parsed = fs.readdirSync(parsedCache).filter((f) => f.endsWith('.json')).length
  } catch (e) {
    parsed = 0
  }
  return {
    caseType: (c && c.caseType) || 'litigation',
    materials: files.length,
    parsed,
    facts: facts.length,
    findings: findings.length,
    clauses,
  }
}

/**
 * 生成简报。
 *
 * 返回的 `line` 是顶栏那一行；`block` 是开场注入用的多行文本（≤15 行）。
 * ⚠ 不许在这里算「下一步该调哪个工具」——那是 lc_case_next 的活，
 *   两边各算一遍就会打架（对方工作台记的「两份数字打架」事故）。
 *
 * @param {{case:string, pkgRoot?:string, next?:object, now?:Date}} p
 *        next 传 lc_case_next 的结果，用来对齐"卡点"，不传就只有核对与材料口径。
 */
export function caseBrief({ case: caseDirRaw, pkgRoot = '', next = null, now = new Date() } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const c = readJson(casePaths(dir).caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}（缺 .lawcase/case.json）`)

  const counts = countsOf(dir)
  let ck = null
  try {
    ck = checkStatus({ case: dir })
  } catch (e) {
    ck = null
  }
  const tri = triState(ck || {})

  // 卡点：优先用调用方给的 next（那是唯一权威），否则按核对与解析自己判
  let blocker = null
  if (next && next.next && next.next.stuck) {
    blocker = { text: String(next.next.stuck), tool: next.next.tool || null, priority: next.next.priority || 99 }
  } else if (counts.materials > counts.parsed) {
    // 材料没解析完是最上游的卡点：事实还没进台账，后面的核对无从谈起
    blocker = { text: `还有 ${counts.materials - counts.parsed} 份材料没解析`, tool: 'lc_material_parse_all', priority: 2 }
  } else if (tri.stale > 0) {
    blocker = { text: `${tri.stale} 条台账核对后又被改过，签字前必须重核`, tool: 'lc_checkoff', priority: 3 }
  } else if (ck && ck.pending > 0) {
    blocker = { text: `${ck.pending} 条台账未核对`, tool: 'lc_checkoff', priority: 4 }
  }

  const last = lastAction(dir, { pkgRoot, now })
  const line = [
    last ? `${last.when}${last.label}${last.detail ? '（' + last.detail + '）' : ''}` : null,
    blocker ? `卡在：${blocker.text}` : null,
  ].filter(Boolean).join(' · ')

  const triLine = `绿 ${tri.verified}｜黄 ${tri.stale}｜灰 ${tri.unverified}（共 ${tri.total}）`

  const block = [
    `【律案】${c.title || path.basename(dir)}｜${c.caseType === 'contract' ? '合同审核' : '诉讼'}｜材料 ${counts.parsed}/${counts.materials}` +
      (counts.clauses ? `｜条款 ${counts.clauses}` : `｜事实 ${counts.facts}｜结论 ${counts.findings}`),
    `【核对】${triLine}`,
    blocker ? `【卡点】${blocker.text}${blocker.tool ? `（${blocker.tool}）` : ''}` : '【卡点】无 —— 可以跑五道验收了',
    last ? `【上次动作】${last.time} ${last.label}${last.detail ? '：' + last.detail : ''}` : '【上次动作】暂无业务操作记录',
  ].join('\n')

  return {
    ok: true,
    case: dir,
    title: c.title || path.basename(dir),
    caseType: counts.caseType,
    counts,
    tri,
    checkoff: ck ? { total: ck.total, done: ck.done, pending: ck.pending, fix: ck.fix, doubt: ck.doubt, stale: ck.stale } : null,
    last,
    blocker,
    line,
    block,
    summary: line || '暂无动作与卡点',
  }
}

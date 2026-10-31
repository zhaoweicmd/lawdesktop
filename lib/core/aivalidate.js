// AI 审核输出的确定性校验：不合格的条目**不得进入可采纳草稿**。
//
// 这是整个 AI 审核的闸门。模型说的话只有过了这里才值钱：
//   · 条款号必须真实存在（模型编一个「第一百二十条」很常见）
//   · severity 必须在枚举内
//   · quote 非空时必须逐字出现在**该条**原文里（不是随便哪条）
//   · 字段长度、空泛话术（沿用 addNote 的同一套规则，避免两处标准漂移）
//
// 三档结论：
//   ok    —— 可直接采纳
//   warn  —— 结构完整但引文没命中/无法定位，降为「待人工确认」，**不可一键采纳**
//   fail  —— 字段残缺或越界，不进草稿列表
//
// 本文件纯函数，不写文件、不调模型。

// VAGUE 直接复用 addNote 的那一份：绝不能在这里另抄一份清单，
// 否则会出现「AI 草稿能过、人工照抄袭登记反被拒收」的标准漂移。
import { QUOTE_MIN, VAGUE, clauseNoOf } from './clause.js'

export const SEVERITIES = ['high', 'medium', 'low']

export const SEVERITY_TO_LEVEL = { high: '重大风险', medium: '建议修改', low: '提示' }

export const SEVERITY_LABEL = { high: '高', medium: '中', low: '低' }

export const MAX_ISSUES = 100
const MAX_TITLE = 60
const MAX_DETAIL = 1200
const MAX_SUGGESTION = 2000
const MAX_QUOTE = 600
const MIN_DETAIL = 15
const MIN_SUGGESTION = 15

const normSpace = (s) => String(s == null ? '' : s).replace(/[\s\u3000]+/g, '').trim()

/**
 * 建「条款号 → 条款」索引。合同里编号有两种写法（字面「第五条」与自动还原的「4」），
 * 模型两种都可能用，所以两边都登记，查找时互相兜底。
 */
export function clauseIndex(clauses) {
  const byNo = new Map()
  for (const c of Array.isArray(clauses) ? clauses : []) {
    const raw = String(c.no == null ? '' : c.no).replace(/\s+/g, '')
    if (!raw) continue
    byNo.set(raw, c)
    const n = clauseNoOf(raw)
    if (n != null) byNo.set(String(n), c)
  }
  return byNo
}

export function findClause(byNo, given) {
  const g = String(given == null ? '' : given).replace(/\s+/g, '')
  if (!g) return null
  const hit = byNo.get(g)
  if (hit) return hit
  const n = clauseNoOf(g)
  return n == null ? null : byNo.get(String(n)) || null
}

/**
 * 校验一条 issue。
 * @returns {{status:'ok'|'warn'|'fail', problems:string[], clause:string, ...}}
 */
export function checkIssue(issue, { byNo, clauses }) {
  const problems = []
  const warnings = []

  const clauseGiven = String((issue && issue.clause) || '').trim()
  if (!clauseGiven) {
    problems.push('缺 clause（条款号）')
  }
  const hit = clauseGiven ? findClause(byNo, clauseGiven) : null
  if (clauseGiven && !hit) problems.push(`合同里没有「${clauseGiven}」这一条`)
  // 回填合同里的真实编号，后续 addNote / ruleClause 才能对上
  const clause = hit ? String(hit.no).replace(/\s+/g, '') : clauseGiven

  const sev = String((issue && issue.severity) || '').trim().toLowerCase()
  if (!SEVERITIES.includes(sev)) problems.push(`severity 必须是 high/medium/low，收到「${issue && issue.severity}」`)

  const title = String((issue && issue.title) || '').trim()
  if (!title) problems.push('缺 title')
  else if (title.length > MAX_TITLE) problems.push(`title 超过 ${MAX_TITLE} 字`)

  const detail = String((issue && issue.detail) || '').trim()
  if (detail.length < MIN_DETAIL) problems.push(`detail 不足 ${MIN_DETAIL} 字`)
  else if (detail.length > MAX_DETAIL) problems.push(`detail 超过 ${MAX_DETAIL} 字`)

  const suggestion = String((issue && issue.suggestion) || '').trim()
  if (suggestion.length < MIN_SUGGESTION) problems.push(`suggestion 不足 ${MIN_SUGGESTION} 字（要能直接粘回合同）`)
  else if (suggestion.length > MAX_SUGGESTION) problems.push(`suggestion 超过 ${MAX_SUGGESTION} 字`)

  // 空泛话术：沿用 addNote 的拒收清单，避免"AI 草稿能过、人工登记被拒"的错位
  const vague = VAGUE.filter((v) => detail.includes(v) || suggestion.includes(v))
  if (vague.length) problems.push(`含空泛表述「${vague.join('、')}」`)

  // ---- 引文：非空就必须**在该条原文里**逐字出现 ----
  const quote = String((issue && issue.quote) || '').trim()
  let quoteOk = null
  let quoteWhere = ''
  if (quote) {
    if (quote.length > MAX_QUOTE) problems.push(`quote 超过 ${MAX_QUOTE} 字`)
    // 「不足 QUOTE_MIN 字」本身不算错：短引文照样可能逐字命中。
    // 之前无条件记 warning，导致「期限为三年」这种 5 字合法引文永远卡在
    // warn、永远无法采纳。只有**同时**没命中原文时才降级。
    if (hit && !problems.some((p) => p.includes('quote 超过'))) {
      quoteOk = normSpace(hit.text).includes(normSpace(quote))
      if (quoteOk) quoteWhere = String(hit.no)
      else {
        // 引文可能抄自别的条款 —— 说清"它其实在哪一条"，人工核对才有线索
        const other = (Array.isArray(clauses) ? clauses : []).find(
          (c) => c && c.no !== hit.no && normSpace(c.text).includes(normSpace(quote))
        )
        if (other) quoteWhere = String(other.no)
        warnings.push(
          other
            ? `引文不在「${hit.no}」原文里，但在「${other.no}」里出现了（模型可能错配了条款）`
            : '引文没有在合同原文里逐字出现（可能是模型改写的）'
        )
      }
    }
  } else if (issue && issue.quote !== '' && issue.quote !== undefined && issue.quote !== null) {
    problems.push('quote 字段类型不对（应为字符串）')
  }

  const status = problems.length ? 'fail' : warnings.length ? 'warn' : 'ok'
  return {
    clause,
    clauseHeading: hit ? String(hit.heading || '') : '',
    located: Boolean(hit),
    severity: sev,
    level: SEVERITY_TO_LEVEL[sev] || '建议修改',
    title,
    detail,
    suggestion,
    // 草稿列表按 addNote 的字段名呈现（issue/fix），人工采纳时直接填表
    issue: detail,
    fix: suggestion,
    quote,
    quoteOk,
    quoteWhere,
    problems,
    warnings,
    status,
    adoptable: status === 'ok',
  }
}

/**
 * 校验整份模型输出。
 *
 * @param {object} p
 * @param {object} p.parsed    模型返回的已解析 JSON
 * @param {Array}  p.clauses   条款索引里的条款
 * @returns {{ok:boolean, issues:Array, skipped:Array, dropped:Array, counts:object, summary:string}}
 *   ok=false 表示**一条都不能用**（例如结构整体不对）；局部失败体现在 dropped。
 */
export function validateModelOutput({ parsed, clauses }) {
  const byNo = clauseIndex(clauses)
  const total = Array.isArray(clauses) ? clauses.length : 0

  const rawIssues = parsed && parsed.issues
  if (!Array.isArray(rawIssues)) {
    return {
      ok: false,
      code: 'schema/issues-missing',
      message: '模型返回的 JSON 里没有 issues 数组：本次审核结果不可用。',
      issues: [],
      skipped: [],
      dropped: [],
      counts: { total: 0, ok: 0, warn: 0, fail: 0, skipped: 0 },
    }
  }
  if (rawIssues.length > MAX_ISSUES) {
    return {
      ok: false,
      code: 'schema/too-many',
      message: `模型返回 ${rawIssues.length} 条问题，超过上限 ${MAX_ISSUES} 条：请缩小审核范围后重试。`,
      issues: [],
      skipped: [],
      dropped: [],
      counts: { total: rawIssues.length, ok: 0, warn: 0, fail: 0, skipped: 0 },
    }
  }

  const issues = []
  const dropped = []
  for (let i = 0; i < rawIssues.length; i += 1) {
    const it = rawIssues[i]
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      dropped.push({ index: i, clause: '', reason: '这一项不是对象', problems: ['结构不正确'] })
      continue
    }
    const chk = checkIssue(it, { byNo, clauses })
    if (chk.status === 'fail') dropped.push({ index: i, clause: chk.clause, reason: chk.title || '', problems: chk.problems })
    else issues.push(chk)
  }

  const skipped = []
  for (const s of Array.isArray(parsed.skipped) ? parsed.skipped : []) {
    if (!s || typeof s !== 'object') continue
    const hit = findClause(byNo, s.clause)
    if (!hit) continue
    skipped.push({
      clause: String(hit.no).replace(/\s+/g, ''),
      why: String(s.why || '').trim().slice(0, 300),
    })
  }

  const ok = issues.filter((x) => x.status === 'ok').length
  const warn = issues.filter((x) => x.status === 'warn').length
  return {
    ok: true,
    issues,
    skipped,
    dropped,
    counts: { total: rawIssues.length, ok, warn, fail: dropped.length, skipped: skipped.length },
    summary:
      `模型给出 ${rawIssues.length} 条问题：可采纳 ${ok} 条` +
      (warn ? `、待人工确认 ${warn} 条` : '') +
      (dropped.length ? `、校验拒收 ${dropped.length} 条` : '') +
      (skipped.length ? `、判定无需修改 ${skipped.length} 条` : '') +
      `（合同共 ${total} 条条款）`,
  }
}

export const _internals = { normSpace, MIN_DETAIL, MIN_SUGGESTION, MAX_TITLE, MAX_DETAIL, MAX_SUGGESTION, MAX_QUOTE }

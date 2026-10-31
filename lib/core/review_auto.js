/**
 * 机器攻击：用台账数据穷举「结构性缺陷」，生成第一回合的可攻击点。
 *
 * 边界说明（必须写清，否则会被误读成"AI 帮你做对抗复盘"）：
 *   - 这里只发现**可由数据判定**的问题：事实没复核、法条没回源、工序没走完……
 *   - 不评判法律论证是否成立、不判断结论对错。那要人做。
 *   - 生成的攻击点标 `auto: true`，回应与裁定仍由人完成——自己攻击自己、
 *     自己判自己，对抗就失效了，所以这里只做第一回合。
 */
import { casePaths, readJson, readJsonl, appendJsonl, nowIso, log } from './store.js'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { checkStatus } from './checkoff.js'

const SEVERITY_ORDER = { 致命: 0, 重大: 1, 一般: 2 }

/** 攻击规则表：每条规则给出触发条件、攻击话术、初判严重度 */
const RULES = [
  {
    id: 'R1',
    name: '事实未复核',
    severity: '重大',
    detect({ factById, refs, checkedIds }) {
      // 只看 checkoff 的「已核对」：confirmed / verified 是历史字段，不再参与判断
      const bad = refs.map((r) => factById.get(r)).filter(Boolean).filter((f) => !f.revoked && !checkedIds.has(f.id))
      if (!bad.length) return null
      return { hit: bad.map((f) => f.id), text: `结论依赖的事实 ${bad.map((f) => f.id).join('、')} 尚未在核对台账里标为已核对，不能作为结论的支撑` }
    },
  },
  {
    id: 'R2',
    name: '事实出处失效',
    severity: '致命',
    detect({ factById, refs, materials }) {
      // 出处是否失效，看的是「材料登记里还认不认这个来源」，不是工作目录下有没有副本。
      // 源材料在归档盘（只读），物理路径随手可取与否不能作为判据。
      const byMid = new Map((materials || []).map((m) => [m.mid, m]))
      const byName = (materials || []).filter((m) => m.rel)
      const resolveOf = (f) => {
        const s = f && f.source
        if (!s) return null
        if (typeof s === 'string') {
          if (/^M\d+$/.test(s)) return byMid.get(s) || null
          const hit = byName.find((m) => String(m.rel).includes(s))
          return hit || null
        }
        if (s.materialId && byMid.has(s.materialId)) return byMid.get(s.materialId)
        if (s.file) return byName.find((m) => String(m.rel).includes(String(s.file))) || null
        return null
      }
      const bad = refs
        .map((r) => factById.get(r))
        .filter(Boolean)
        .filter((f) => f.source && !resolveOf(f))
      if (!bad.length) return null
      return { hit: bad.map((f) => f.id), text: `事实 ${bad.map((f) => f.id).join('、')} 标注的出处不在材料登记里（材料可能被改名、移走或未扫描），「事实必有出处」不成立` }
    },
  },
  {
    id: 'R3',
    name: '法条未回源',
    severity: '重大',
    detect({ lawByTitle }) {
      const bad = [...lawByTitle.values()].filter((l) => l.status === 'unverified')
      if (!bad.length) return null
      return { hit: bad.map((l) => l.id), text: `引用的法条 ${bad.map((l) => l.id).join('、')} 还没回源核验，条文内容可能抄错或已失效` }
    },
  },
  {
    id: 'R4',
    name: '法条原文与权威库不一致',
    severity: '致命',
    detect({ lawByTitle }) {
      const bad = [...lawByTitle.values()].filter((l) => l.status === 'mcp-mismatch')
      if (!bad.length) return null
      return { hit: bad.map((l) => l.id), text: `法条 ${bad.map((l) => l.id).join('、')} 的登记原文与北大法宝不一致，属于「编号对、内容错」` }
    },
  },
  {
    id: 'R5',
    name: '法条已失效',
    severity: '致命',
    detect({ lawByTitle }) {
      const bad = [...lawByTitle.values()].filter((l) => l.timeliness && !/现行有效/.test(l.timeliness))
      if (!bad.length) return null
      return { hit: bad.map((l) => l.id), text: `法条 ${bad.map((l) => l.id).join('、')} 法宝标注为「${bad[0].timeliness}」，已不能直接引用` }
    },
  },
  {
    id: 'R6',
    name: '结论没有法律依据',
    severity: '重大',
    detect({ findings }) {
      const bad = findings.filter((f) => !f.law && !f.lawRef)
      if (!bad.length) return null
      return { hit: bad.map((f) => f.id), text: `结论 ${bad.map((f) => f.id).join('、')} 没有给出任何法律依据` }
    },
  },
  {
    id: 'R7',
    name: '结论引用事实过少',
    severity: '一般',
    detect({ findings, facts }) {
      if (facts.length < 3) return null
      const bad = findings.filter((f) => (f.factRefs || []).length < 2)
      if (!bad.length) return null
      return { hit: bad.map((f) => f.id), text: `案件已有 ${facts.length} 条事实，但结论 ${bad.map((f) => f.id).join('、')} 只引用 1 条，可能遗漏关键前提` }
    },
  },
  {
    id: 'R8',
    name: '工序未完成即出结论',
    severity: '重大',
    detect({ proc, findings }) {
      if (!proc.length || !findings.length) return null
      const undone = proc.filter((p) => p.status !== 'done')
      if (!undone.length) return null
      return { hit: undone.map((p) => p.id), text: `仍有 ${undone.length} 道工序未完成（${undone.map((p) => p.id).join('、')}），此阶段的结论属于提前产出` }
    },
  },
  {
    id: 'R9',
    name: '五道验收未通过',
    severity: '重大',
    detect({ verifyResult }) {
      if (!verifyResult) return null
      const fails = (verifyResult.checks || []).filter((c) => c.status === 'fail')
      if (!fails.length) return null
      return { hit: fails.map((c) => c.title), text: `五道验收有 ${fails.length} 道未通过：${fails.map((c) => c.title).join('、')}` }
    },
  },
  {
    id: 'R10',
    name: '结论表述空泛',
    severity: '一般',
    detect({ findings }) {
      const VAGUE = /(进一步明确|予以完善|酌情|建议加强|有待|视情况)/
      const bad = findings.filter((f) => VAGUE.test(f.text || ''))
      if (!bad.length) return null
      return { hit: bad.map((f) => f.id), text: `结论 ${bad.map((f) => f.id).join('、')} 含空泛表述，无法直接落地` }
    },
  },
]

/**
 * 一键机器攻击：生成第一回合的可攻击点（不自动回应、不自动裁定）。
 */
export function autoReview({ case: caseDirRaw, subject, verifyResult = null }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}`)

  const facts = readJsonl(cp.facts).filter((x) => !x.__broken && !x.revoked)
  const findings = readJsonl(cp.findings).filter((x) => !x.__broken && !x.revoked)
  const laws = readJsonl(cp.laws).filter((x) => !x.__broken)

  if (!findings.length) throw new Error('还没有任何结论（findings.jsonl 为空），没有可复盘的标的')

  let mats = []
  try {
    const mj = readJson(cp.materials, null)
    mats = (mj && mj.files) || []
  } catch {}
  const factById = new Map(facts.map((f) => [f.id, f]))
  const lawByTitle = new Map(laws.map((l) => [l.id, l]))
  const refs = [...new Set(findings.flatMap((f) => f.factRefs || []))]
  // 核对状态只有一份口径：checkoff（逐条核对台账）。
  // 以前 R1 读 f.confirmed，而 addFact 写的是 verified，永远判成「未复核」。
  let checkedIds = new Set()
  try {
    const ck = checkStatus({ case: dir })
    checkedIds = new Set((ck.items || []).filter((x) => x.kind === 'fact' && x.result === 'ok').map((x) => x.id))
  } catch (e) {}

  const ctx = { factById, refs, facts, findings, laws, lawByTitle, materials: mats, proc: c.proc || [], verifyResult, dir, checkedIds }
  const hits = []
  for (const rule of RULES) {
    const r = rule.detect(ctx)
    if (r) hits.push({ rule: rule.id, name: rule.name, severity: rule.severity, ...r })
  }

  if (!hits.length) {
    return {
      ok: true,
      round: null,
      subject,
      count: 0,
      summary: '未发现可由数据判定的结构性问题。注意：这只说明台账自洽，不代表法律论证站得住',
      items: [],
      hint: '如需真正的对抗，请人工指定攻击角度后调 lc_review_open + lc_review_attack',
    }
  }

  // 开一轮并写入攻击点
  const rows = readJsonl(cp.review).filter((r) => !r.__broken)
  const rounds = [...new Set(rows.filter((r) => r.round).map((r) => r.round))]
  const next = rounds.length ? `R${Math.max(...rounds.map((x) => Number(String(x).replace(/^R/, '')) || 0)) + 1}` : 'R1'
  appendJsonl(cp.review, { type: 'open', round: next, subject: String(subject || '自动复盘'), at: nowIso() })

  const existing = rows.filter((r) => r.round === next && r.type === 'attack')
  let seq = existing.length
  const items = []
  for (const h of hits) {
    seq += 1
    const aid = `A${seq}`
    appendJsonl(cp.review, {
      type: 'attack',
      round: next,
      aid,
      target: h.hit.join('、'),
      text: h.text,
      auto: true,
      rule: h.rule,
      at: nowIso(),
    })
    items.push({ aid, rule: h.rule, name: h.name, severity: h.severity, target: h.hit.join('、'), text: h.text })
  }
  log(dir, 'review-auto', { round: next, count: items.length })

  const bySeverity = {}
  for (const it of items) bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1
  const order = ['致命', '重大', '一般'].filter((s) => bySeverity[s])
  const summary =
    `${next} 生成 ${items.length} 个攻击点：` +
    order.map((s) => `${s} ${bySeverity[s]}`).join('｜') +
    ` —— 逐条调 lc_review_reply 回应、lc_review_verdict 裁定`

  return {
    ok: true,
    round: next,
    subject: String(subject || '自动复盘'),
    count: items.length,
    bySeverity,
    items,
    summary,
    hint: '攻击点由台账数据判定，已标 auto=true；回应与裁定必须人做，不能自动闭环',
  }
}

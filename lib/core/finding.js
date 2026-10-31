import { casePaths, readJson, readJsonl, appendJsonl, writeJsonAtomic, writeTextAtomic, log } from './store.js'
import { renderConclusionMd } from './case.js'

/** 空泛话术：出现即视为「等于没写」 */
const VAGUE = [
  '建议进一步明确', '建议进一步完善', '建议完善', '建议明确', '建议补充',
  '尚需明确', '有待明确', '需进一步明确', '进一步规范', '予以重视', '加强管理',
]

function loadCase(dir) {
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}（缺 .lawcase/case.json）`)
  return { cp, c }
}

/** 登记一条结论：必须引用存在的事实；引用法条必须给出回源定位 */
export function addFinding(args) {
  const dir = args.case
  const { cp, c } = loadCase(dir)

  const t = String(args.text || '').trim()
  if (!t) throw new Error('结论正文为空')
  if (t.length < 15) {
    throw new Error(`结论过短（${t.length} 字）：要能独立读懂「谁对谁、基于什么、得出什么」，至少 15 字`)
  }
  const hit = VAGUE.find((v) => t.includes(v))
  if (hit) {
    throw new Error(`结论含空泛话术「${hit}」：改成可直接落地的话（改什么、改成什么、依据哪条），否则等于没写`)
  }

  const facts = readJsonl(cp.facts)
  const factIds = new Set(facts.map((f) => f.id))
  const refs = Array.isArray(args.factRefs) ? args.factRefs.filter(Boolean) : []
  if (!refs.length) throw new Error('未引用任何事实编号：结论必须挂在具体事实上（先用 lc_fact_add 登记）')
  const missing = refs.filter((r) => !factIds.has(r))
  if (missing.length) {
    throw new Error(`引用了不存在的事实 ${missing.join('、')}：先用 lc_fact_add 登记，或改正编号`)
  }

  let lawRef = args.law ? String(args.law).trim() : ''
  let src = null
  if (lawRef) {
    const ls = args.lawSource || {}
    if (!ls.url && !ls.locator) {
      throw new Error(`引用了法条「${lawRef}」但没有回源定位：lawSource 必须给 url（法规库链接）或 locator（库名 + 条号），否则算未回源`)
    }
    src = { url: ls.url || undefined, locator: ls.locator || undefined, note: ls.note || undefined }
  } else {
    lawRef = ''
  }

  const existing = readJsonl(cp.findings)
  const id = `K${existing.length + 1}`
  const rec = {
    id,
    text: t,
    factRefs: refs,
    law: lawRef || undefined,
    lawSource: src || undefined,
    confidence: args.confidence || undefined,
    status: 'draft',
    createdAt: new Date().toISOString(),
  }
  appendJsonl(cp.findings, rec)

  const all = readJsonl(cp.findings)
  c.findingsCount = all.length
  c.updatedAt = rec.createdAt
  writeJsonAtomic(cp.caseJson, c)
  writeTextAtomic(cp.conclusion, renderConclusionMd(c, all))
  log(dir, 'finding-add', { id, facts: refs.length, law: !!lawRef })

  return {
    ok: true, id, ...rec,
    summary: `已登记结论 ${id}（引用 ${refs.length} 条事实${lawRef ? `、法条「${lawRef}」` : '、无法条引用'}）`,
  }
}

/** 读结论台账 */
export function listFindings(args) {
  const dir = args.case
  const { cp, c } = loadCase(dir)
  const items = readJsonl(cp.findings)
  const facts = readJsonl(cp.facts)
  const factIds = new Set(facts.map((f) => f.id))
  const rows = items.map((f) => {
    const refs = f.factRefs || []
    const broken = refs.filter((r) => !factIds.has(r))
    return {
      id: f.id,
      text: f.text,
      factRefs: refs,
      law: f.law || null,
      lawSource: f.lawSource || null,
      status: f.status || 'draft',
      trace: broken.length ? 'broken' : f.law ? (f.lawSource ? 'ok' : 'unverified') : 'ok',
      brokenRefs: broken.length ? broken : undefined,
    }
  })
  const broken = rows.filter((r) => r.trace === 'broken').length
  return {
    caseId: c.caseId,
    count: rows.length,
    broken,
    items: rows,
    summary: rows.length
      ? `共 ${rows.length} 条结论${broken ? `，其中 ${broken} 条事实引用失效` : '，事实引用完整'}`
      : '结论台账为空：还没有结论（先用 lc_proc_plan 建工序、lc_fact_add 登记事实）',
  }
}

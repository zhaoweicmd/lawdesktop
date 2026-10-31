// 机器预核：能由机器判定的，先判掉；判不了的，明确交给人工。
//
// 分工（这条界线不能含糊）：
//   机器能判 —— 引文是否真在那份材料的解析文本里、出处材料是否存在、页码是否越界、
//               结论引用的 F 是否存在、法条是否废止/有无原文（后者在 lawtrace 里）
//   机器判不了 —— 这句话在事实上是否成立、结论在法律上是否站得住、材料是否伪造
//
// 所以本模块只产出三种灯：
//   green  机器已核：该查的都对上了（不等于「内容经人判断」）
//   yellow 机器判不了：缺引文/缺材料编号/定位无法解析 → 必须人工看
//   red    机器查出矛盾：引文找不到、出处缺失、页码越界、引用了不存在的编号 → 必须处理
//
// 不调 LLM，纯文本比对。

import fs from 'node:fs'
import path from 'node:path'

import { casePaths, readJson, readJsonl } from './store.js'
import { loadFacts } from './fact.js'
import { checkQuote } from './parse.js'

const sq = (s) => String(s || '').replace(/\s+/g, '')

function loadCase(dir) {
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}（缺 .lawcase/case.json）`)
  return { cp, c }
}

/** 读某份材料的解析文本（没有解析过则为 null） */
export function parseTextOf(cp, mid) {
  const p = path.join(cp.cache, 'parse', `${String(mid).toUpperCase()}.json`)
  const doc = readJson(p, null)
  if (!doc) return null
  const units = Array.isArray(doc.units) ? doc.units : []
  return {
    mid: String(mid).toUpperCase(),
    rel: doc.rel || '',
    text: sq(units.map((u) => u.text || '').join('\n')),
    units,
    engine: doc.engine || '',
    unitCount: units.length,
  }
}

/** 从「第2页 / P2 / 第2段」里抠出页码（拿不到就 null） */
function pageOf(locator) {
  const s = String(locator || '')
  const m = s.match(/(?:第\s*|P|p)(\d+)\s*页?/) || s.match(/(\d+)/)
  return m ? Number(m[1]) : null
}

/**
 * 对「事实台账」做机器预核。
 * @param {{case:string}} opts
 */
export function machineCheckFacts({ case: caseDirRaw } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  if (!caseDirRaw) throw new Error('case 不能为空')
  const { cp } = loadCase(dir)
  const facts = loadFacts(dir).active
  const mats = (readJson(cp.materials, null) || { files: [] }).files || []
  const byMid = new Map(mats.map((m) => [String(m.mid).toUpperCase(), m]))
  const cache = new Map() // mid → parseText 结果，避免重复读盘

  const items = []
  for (const f of facts) {
    const problems = []
    const notes = []
    const src = f.source || {}
    const mid = String(src.materialId || '').toUpperCase()
    const mat = mid ? byMid.get(mid) : null
    const quote = String(f.quote || '').trim()

    // 1) 出处材料是否存在
    if (!mid) {
      notes.push('没标材料编号（materialId）：无法定位到具体是哪份材料')
    } else if (!mat) {
      problems.push(`出处材料 ${mid} 不在材料台账里：可能是重扫后编号变了`)
    }

    // 2) 页码是否越界（材料有解析文本才算得出来）
    let parsed = null
    if (mat) {
      if (!cache.has(mid)) cache.set(mid, parseTextOf(cp, mid))
      parsed = cache.get(mid)
      const page = pageOf(src.locator)
      if (parsed && page != null) {
        const maxPage = parsed.units.reduce((mx, u) => {
          const p = pageOf(u.page != null ? String(u.page) : '')
          return p != null && p > mx ? p : mx
        }, 0)
        // 解析单元没带页码时（docx 常见）不做越界判断，别误报
        if (maxPage && page > maxPage) {
          problems.push(`定位写「${src.locator}」，但这份材料只解析到第 ${maxPage} 页：页码可能记错了`)
        }
      }
    }

    // 3) 引文是否逐字在原文里 —— 复用验收那套 checkQuote，别再写第二套判断。
    // 以前这里自己用「全文 includes」判定，和验收给的 ocr-poor/misplaced 结论打架：
    // 同一份数据，验收说「OCR 乱码、机器比对不了」，预核说「引文找不到=矛盾」。
    if (!quote) {
      notes.push('没有原文引句（quote）：机器无法核对这句话是否真在材料里')
    } else if (mat) {
      if (!parsed) {
        notes.push(`${mid} 还没解析，无法比对引文（先批量解析）`)
      } else {
        const q = checkQuote(
          { units: parsed.units, pages: parsed.pageCount },
          src.locator,
          quote
        )
        if (q.verdict === 'ok') {
          // 命中，不用记东西
        } else if (q.verdict === 'misplaced') {
          // 引文真实存在、位置写错：不是矛盾，是可修的定位问题
          notes.push(`${q.why}`)
        } else if (q.verdict === 'ocr-poor') {
          notes.push(`${q.why}（人工核对原图即可，机器帮不上）`)
        } else if (q.verdict === 'unsupported') {
          notes.push(`${q.why}`)
        } else {
          problems.push(`引文在文件里找不到（可能摘错或造假）：「${quote.slice(0, 30)}…」`)
        }
      }
    }

    const light = problems.length ? 'red' : notes.length ? 'yellow' : 'green'
    items.push({
      kind: 'fact',
      id: f.id,
      text: String(f.text || '').slice(0, 80),
      mid,
      locator: src.locator || '',
      quote: quote.slice(0, 60),
      light,
      problems,
      notes,
      // 机器能不能替人判：只有 green 才算「机器已核」
      machineVerdict: light === 'green' ? 'ok' : light === 'red' ? 'conflict' : 'undecidable',
    })
  }

  const green = items.filter((x) => x.light === 'green')
  const yellow = items.filter((x) => x.light === 'yellow')
  const red = items.filter((x) => x.light === 'red')
  return {
    ok: true,
    kind: 'fact',
    total: items.length,
    green: green.length,
    yellow: yellow.length,
    red: red.length,
    items,
    summary:
      `机器预核 ${items.length} 条事实：可直接确认 ${green.length}，需人工判断 ${yellow.length}，查出矛盾 ${red.length}`,
    note:
      '「可直接确认」= 引文逐字命中、出处材料存在、页码不越界。' +
      '它证明这句话确实写在材料里，**不证明**这句话在事实上成立或结论在法律上站得住——那部分永远要看人。',
  }
}

/**
 * 对「结论台账」做机器预核：引用的 F 是否存在、有没有标法条、法条是否在台账里。
 */
export function machineCheckFindings({ case: caseDirRaw } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  if (!caseDirRaw) throw new Error('case 不能为空')
  const { cp } = loadCase(dir)
  const factIds = new Set(loadFacts(dir).active.map((f) => f.id))
  const laws = readJsonl(cp.laws).filter((x) => !x.__broken)
  const lawIds = new Set(laws.map((l) => l.id))
  const findings = readJsonl(cp.findings).filter((f) => !f.__broken && !f.__revoked)

  const items = []
  for (const f of findings) {
    const problems = []
    const notes = []
    const refs = Array.isArray(f.factRefs) ? f.factRefs : []
    if (!refs.length) notes.push('没有引用任何事实编号：结论悬空，机器无法核对依据')
    const missing = refs.filter((r) => !factIds.has(String(r)))
    if (missing.length) problems.push(`引用了不存在或已作废的事实：${missing.join('、')}`)

    const lawId = String(f.law || '').trim()
    if (!lawId) notes.push('没有标注依据的法条编号')
    else if (!lawIds.has(lawId)) problems.push(`引用了法条 ${lawId}，但法条台账里没有这一条`)

    if (!f.lawSource || (!f.lawSource.url && !f.lawSource.locator)) {
      notes.push('结论上没有法条回源定位（url 或「库名+条号」）')
    }

    const light = problems.length ? 'red' : notes.length ? 'yellow' : 'green'
    items.push({
      kind: 'finding',
      id: f.id,
      text: String(f.text || '').slice(0, 80),
      refs,
      lawId,
      light,
      problems,
      notes,
      machineVerdict: light === 'green' ? 'ok' : light === 'red' ? 'conflict' : 'undecidable',
    })
  }

  const green = items.filter((x) => x.light === 'green').length
  const yellow = items.filter((x) => x.light === 'yellow').length
  const red = items.filter((x) => x.light === 'red').length
  return {
    ok: true,
    kind: 'finding',
    total: items.length,
    green,
    yellow,
    red,
    items,
    summary: `机器预核 ${items.length} 条结论：可直接确认 ${green}，需人工判断 ${yellow}，查出矛盾 ${red}`,
    note: '「可直接确认」只说明引用的事实编号与法条编号都存在，不说明论证成立。',
  }
}

/** 一次跑完（目前覆盖事实与结论；材料清单的核对项简单，留在人工） */
export function machinePrecheck({ case: caseDirRaw } = {}) {
  const facts = machineCheckFacts({ case: caseDirRaw })
  const findings = machineCheckFindings({ case: caseDirRaw })
  return {
    ok: true,
    facts,
    findings,
    summary: `${facts.summary}｜${findings.summary}`,
    note: facts.note,
  }
}

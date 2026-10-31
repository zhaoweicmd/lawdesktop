// 合同预检：机器能可靠发现的那部分硬伤。
//
// 定位：这是「做账不做脑」里最硬的一块——不用读懂合同也能判的问题。
//   - 占位符没填（____、〔…〕、待填写、XX、空括号）
//   - 条款编号重复/跳号
//   - 引用了附件但没有附件条款
//   - 关键条款关键词全无（只在关键词缺失时才报，且明确声明这不能证明条款充分）
//   - 没有签署/盖章字样
//
// 每条结论都要能指到具体条款和原文片段，否则不给结论。
// 本文件不调 LLM，纯函数可单测。

import path from 'node:path'

import { casePaths, readJson, readJsonl, log } from './store.js'
import { loadClauses } from './clause.js'
import { cn2int } from './redline.js'

/** 级别与审核意见共用一套（NOTE_LEVELS），别各写一份 */
const HIGH = '重大风险'
const MED = '建议修改'
const LOW = '提示'

/** 占位符：这些痕迹说明「这里本来要填，但没填」 */
const PLACEHOLDER_PATTERNS = [
  { re: /_{3,}/g, label: '下划线空位' },
  { re: /＿{3,}/g, label: '全角下划线空位' },
  { re: /〔[^〕\n]{0,40}〕/g, label: '〔〕模板占位' },
  { re: /\[[^\]\n]{0,30}\]/g, label: '[] 待填占位' },
  { re: /(?:待填写|待补充|待协商|待确定|待定|TBD)/g, label: '待填字样' },
  { re: /X{2,}/g, label: 'XX 占位' },
  { re: /[（(]\s*[）)]/g, label: '空括号' },
]

/** 关键条款覆盖：关键词出现即视为「有」，没出现才报"未检索到"。 */
const COVERAGE_RULES = [
  { id: 'payment', title: '付款与价款', keywords: ['付款', '支付', '价款', '合同金额', '总价', '结算'] },
  { id: 'delivery', title: '交付与验收', keywords: ['验收', '交付', '交货', '完工', '入库'] },
  { id: 'breach', title: '违约责任', keywords: ['违约', '赔偿', '损失'] },
  { id: 'dispute', title: '争议解决', keywords: ['争议', '仲裁', '管辖', '诉讼'] },
  { id: 'term', title: '期限与生效', keywords: ['生效', '期限', '有效期', '终止', '解除'] },
  { id: 'confidential', title: '保密', keywords: ['保密', '商业秘密'] },
]

// 只认「签署行为」的字样：不把「签订后付款」当成签署安排
// （「签订」几乎只作动词出现在付款条款里，拿它当依据会让这条检查永远不触发）
const SIGN_KEYWORDS = ['签字', '盖章', '签署', '签章', '签订日期']

/** 一条预检结论 */
function finding(seq, ruleId, level, title, detail, extra = {}) {
  return {
    id: 'PC' + seq,
    ruleId,
    level,
    title,
    detail,
    clause: extra.clause || '',
    quote: extra.quote ? String(extra.quote).slice(0, 120) : '',
    hint: extra.hint || '',
  }
}

/** 条款正文拼接（含标题行，splitClauses 的 text 已经包含标题） */
function clauseText(c) {
  return String((c && (c.text || c.heading)) || '')
}

/**
 * 对一份已索引的合同做预检。
 * @param {{ fileName?: string, clauses: Array }} input
 */
export function precheckDocument({ fileName = '', clauses = [] } = {}) {
  const list = Array.isArray(clauses) ? clauses.filter(Boolean) : []
  const findings = []
  let seq = 0
  const push = (ruleId, level, title, detail, extra) => findings.push(finding(++seq, ruleId, level, title, detail, extra))

  // 1) 占位符：逐条扫，带上条款号与上下文片段
  for (const c of list) {
    const text = clauseText(c)
    for (const p of PLACEHOLDER_PATTERNS) {
      p.re.lastIndex = 0
      const hits = []
      let m
      while ((m = p.re.exec(text))) {
        const at = m.index
        hits.push({
          raw: m[0],
          context: text.slice(Math.max(0, at - 20), Math.min(text.length, at + m[0].length + 20)).replace(/\s+/g, ' '),
        })
        if (hits.length >= 3) break // 同一条款同一种占位报一次就够
      }
      if (!hits.length) continue
      const sample = hits[0]
      push(
        'placeholder',
        HIGH,
        `${c.no || '（无条款号）'} 有未填的${p.label}`,
        `发现 ${hits.length >= 3 ? '3 处以上' : hits.length + ' 处'}「${sample.raw}」：${sample.context}` +
          '——合同里凡是留着空位的地方，一旦签署就可能被对方主张"已约定不明"，必须逐处填实或删除。',
        { clause: c.no || '', quote: sample.context, hint: '把〔〕/____ 处填成具体内容；确实需要留白的，改成明确的"由双方另行书面确认"' }
      )
    }
  }

  // 2) 条款编号：重复 / 跳号（只提示，不替用户判定"少了哪条"）
  const seen = new Map()
  const numbers = []
  for (const c of list) {
    const raw = String((c && c.no) || '').replace(/^第/, '').replace(/条.*$/, '').trim()
    // 「总则」「附件一」这类不是条号：cn2int 对无法识别的字会返回 0，必须先挡住
    if (!/^[零一二三四五六七八九十百两\d]+$/.test(raw)) continue
    const n = cn2int(raw)
    if (!Number.isFinite(n)) continue
    numbers.push({ n, no: c.no })
    if (seen.has(n)) {
      push(
        'clause-number',
        HIGH,
        `条款编号重复：${c.no}`,
        `「第${n}条」出现了两次（${seen.get(n)} 与 ${c.no}）：编号重复会让"依第X条"的引用指向不明，修改意见也无法唯一定位。`,
        { clause: c.no, hint: '核对原文编号，重号通常是复制粘贴造成的' }
      )
    } else {
      seen.set(n, c.no)
    }
  }
  if (numbers.length >= 2) {
    const uniq = [...new Set(numbers.map((x) => x.n))].sort((a, b) => a - b)
    const gaps = []
    for (let i = 1; i < uniq.length; i += 1) {
      if (uniq[i] - uniq[i - 1] > 1) gaps.push(`${uniq[i - 1]}→${uniq[i]}`)
    }
    if (gaps.length) {
      push(
        'clause-number',
        LOW,
        '条款编号不连续',
        `编号出现了跳号：${gaps.join('、')}。可能是删条款后没重排，也可能是切分时漏段——请人工确认中间是否缺内容。`,
        { hint: '跳号本身不一定是错；要确认的是"跳掉的那几条内容去哪了"' }
      )
    }
  }

  // 3) 附件引用 vs 附件条款
  const allText = list.map(clauseText).join('\n')
  const attachRefs = [...new Set([...allText.matchAll(/附件\s*([一二三四五六七八九十百\d]{1,3})/g)].map((m) => m[0]))]
  const hasAttachClause = list.some((c) => /附件/.test(String(c.heading || '')) && !/(详见|见|如|按)\s*附件/.test(String(c.heading || '')))
  if (attachRefs.length && !hasAttachClause) {
    push(
      'attachment',
      MED,
      '引用了附件，但没有附件条款',
      `正文 ${attachRefs.length} 处提到附件（${attachRefs.slice(0, 3).join('、')}），但没有独立的"附件"条款约定附件清单、效力与交付。附件不明确时，附件内容可能被主张为未达成合意。`,
      { hint: '补一条附件条款：列明附件名称、页数、双方签字确认方式，并写明"附件与本合同具有同等效力"' }
    )
  }

  // 4) 关键条款覆盖（关键词法，必须自我声明边界）
  for (const rule of COVERAGE_RULES) {
    if (rule.keywords.some((k) => allText.includes(k))) continue
    push(
      'coverage',
      LOW,
      `未检索到：${rule.title}`,
      `全篇没有出现任何相关关键词（${rule.keywords.slice(0, 3).join('/')}…）。` +
        '本项只检查关键词是否出现，不能判断条款是否充分——请人工确认是真的没有，还是换了说法。',
      { hint: `若确无，建议补一条${rule.title}条款；若已有，可忽略本提示` }
    )
  }

  // 5) 签署
  if (!SIGN_KEYWORDS.some((k) => allText.includes(k))) {
    push(
      'signature',
      MED,
      '未检索到签署/盖章安排',
      '全篇没有出现「签字/盖章/签署/签订」等字样：合同生效要件与签署页缺失，容易出现"已履行但未成立"的争议。',
      { hint: '补签署页：双方名称、授权代表、签字盖章位置、签署日期' }
    )
  }

  const order = { [HIGH]: 0, [MED]: 1, [LOW]: 2 }
  const sorted = findings
    .sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9) || Number(a.id.slice(2)) - Number(b.id.slice(2)))
    // 编号跟着显示顺序走：界面按 PC1… 顺读时，严重度就是从高到低，不必再解释
    .map((f, i) => ({ ...f, id: 'PC' + (i + 1) }))
  const byLevel = {}
  for (const f of sorted) byLevel[f.level] = (byLevel[f.level] || 0) + 1
  const findingsFinal = sorted

  return {
    file: fileName,
    clauses: list.length,
    count: findingsFinal.length,
    byLevel,
    findings: findingsFinal,
    summary: findingsFinal.length
      ? `${fileName || '合同'}：预检 ${findings.length} 项（` +
        Object.entries(byLevel).map(([k, v]) => `${k} ${v}`).join('、') +
        '）'
      : `${fileName || '合同'}：预检通过（${list.length} 条条款，无占位符/编号/附件/覆盖问题）`,
  }
}

/**
 * 对案件里已索引的合同做预检。
 * @param {{ case: string, file?: string }} opts
 */

/**
 * 找出「AI 报出风险、但没人处理」的条款。
 *
 * 三个来源要一起看，缺一个就会误报或漏报：
 *   · 草稿（note-drafts.json）—— AI 说了什么
 *   · 已登记意见（notes.jsonl）—— 人采纳了哪些
 *   · 条款判定（rulings.jsonl）—— 人明确说了"不用改"的有哪些
 *
 * 只有「草稿里有、且后两者都没覆盖」的条款才算未处理。
 * 判据用条款号归一（1 与 第一条 视为同一条），否则又会出现"改了一处、另一处还报"。
 */
function untouchedDrafts(dir, targets, existing) {
  const empty = { groups: [], config: null, skipped: [], total: 0 }
  let doc = null
  try {
    doc = readJson(path.join(casePaths(dir).state, 'note-drafts.json'), null)
  } catch (e) {
    return empty
  }
  const all = doc && Array.isArray(doc.drafts) ? doc.drafts.filter((x) => x && x.clause && x.ok !== false) : []
  // AI 在 skipped 里明确说「无需修改」的条款：不算未处理，
  // 否则预检会把「AI 说没问题」也报成问题（用户 2026-11-01 指出的「有些内容本身是能过的」）。
  const aiSaysFine = new Set(
    (doc && Array.isArray(doc.skipped) ? doc.skipped : []).map((x) => keyOf(x && x.clause))
  )
  if (!all.length) return empty

  let notes = []
  try {
    notes = readJsonl(casePaths(dir).notes).filter((r) => r && !r.__broken && !r.__deleted && r.clause)
  } catch (e) {
    notes = []
  }
  let rulings = []
  try {
    rulings = readJsonl(path.join(casePaths(dir).state, 'rulings.jsonl')).filter((r) => r && !r.__broken && !r.__deleted && r.clause)
  } catch (e) {
    rulings = []
  }
  const doneByNote = new Set(notes.map((n) => keyOf(n.clause)))
  const doneByRuling = new Set(rulings.filter((r) => r.kind === 'norevision').map((r) => keyOf(r.clause)))

  const names = new Set((targets || []).map((f) => f.name))
  const byClause = new Map()
  for (const d of all) {
    if (d.file && names.size && !names.has(d.file)) continue
    const k = keyOf(d.clause)
    if (doneByNote.has(k) || doneByRuling.has(k) || aiSaysFine.has(k)) continue
    if ((existing || []).some((f) => f.ruleId === 'ai-untouched' && f.clause === d.clause)) continue
    if (!byClause.has(k)) byClause.set(k, { clause: d.clause, file: d.file || '', clauses: [], groupsByLevel: {} })
    const g = byClause.get(k)
    g.clauses.push(d)
    g.groupsByLevel[d.level] = (g.groupsByLevel[d.level] || 0) + 1
  }
  return {
    groups: [...byClause.values()].map((x) => ({ ...x, count: x.clauses.length })),
    config: (doc && doc.config) || null,
    skipped: (doc && Array.isArray(doc.skipped) ? doc.skipped : []).map((x) => ({ clause: x.clause, why: x.why })),
    total: all.length,
  }
}

/** 条款号归一：1 与「第一条」视为同一条 */
function keyOf(no) {
  const raw = String(no || '')
  const n = cn2int(raw.replace(/[^零一二三四五六七八九十百两\d]/g, ''))
  return Number.isFinite(n) && n > 0 ? 'N' + n : raw.replace(/\s+/g, '')
}

/** AI 审核口径：让预检页能说明"按什么标准审的" */
function aiReviewMeta(dir) {
  try {
    const doc = readJson(path.join(casePaths(dir).state, 'note-drafts.json'), null)
    if (!doc) return null
    const c = doc.config || {}
    return {
      at: doc.at || '',
      reviewId: doc.reviewId || '',
      file: doc.file || '',
      stance: c.stance || '',
      templateId: c.templateId || '',
      instructions: c.instructions || '',
      brief: c.brief || '',
      model: doc.model ? `${doc.model.provider || ''}/${doc.model.model || ''}` : '',
      counts: {
        drafts: (doc.drafts || []).length,
        skipped: (doc.skipped || []).length,
      },
    }
  } catch (e) {
    return null
  }
}


export function precheckCase({ case: caseDirRaw, file } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  if (!caseDirRaw) throw new Error('case 不能为空：请给出案件工作目录绝对路径')
  if (!readJson(casePaths(dir).caseJson, null)) throw new Error(`不是 LawCase 案件：${dir}`)

  const files = loadClauses(dir)
  if (!files.length) {
    throw new Error('还没有条款索引：先 lc_clause_index 把合同切成条款，预检才能指到具体条款')
  }
  const want = String(file || '').trim()
  const targets = want ? files.filter((f) => f.name === want || f.file === want) : files
  if (want && !targets.length) {
    throw new Error(`条款索引里没有这份合同：${want}（已索引：${files.map((f) => f.name).join('、')}）`)
  }

  const docs = targets.map((f) => precheckDocument({ fileName: f.name, clauses: f.clauses || [] }))
  const findings = docs.flatMap((d) => d.findings.map((x) => ({ ...x, file: d.file })))

  // ---- AI 意见纳入预检（用户 2026-11-01）----
  // 原来预检只看文本自身（占位符/编号/附件/关键词/签署），
  // 完全不看 AI 已审出的风险。后果：AI 报了 21 条，预检照样说"通过"，
  // 用户以为合同没问题就交付了。
  //
  // 这里把「AI 提了风险、但既没采纳也没标『无需修改』」的条款单列出来。
  // 判据：草稿里有、且该条款在 rulings 里没有 norevision 判定、也没有已登记意见。
  const ai = untouchedDrafts(dir, targets, findings)
  for (const t of ai.groups) {
    // 只把 AI 认为**确实有问题**的当预检项。
    // 用户 2026-11-01：「有些内容本身是能过的」——
    // AI 的「提示」级、以及 AI 在 skipped 里明确说"无需修改"的条款，
    // 都不该在预检里变成拦路的硬伤，否则预检会把「AI 说没事」也报成问题。
    const sev = t.groupsByLevel
    const real = t.clauses.filter((x) => x.level === '重大风险' || x.level === '建议修改')
    if (!real.length) continue
    const level = sev['重大风险'] ? HIGH : sev['建议修改'] ? '建议修改' : LOW
    findings.push({
      id: 'PC-AI-' + t.clause,
      ruleId: 'ai-untouched',
      level,
      title: `${t.clause} 有 AI 报出的风险未处理（${real.length} 条）`,
      detail:
        `${real.slice(0, 3).map((x) => '「' + String(x.issue || '').slice(0, 40) + '…」').join('、')}` +
        '——AI 已经指出问题，但既没有采纳成意见、也没有标记「无需修改」。' +
        '直接交付等于把 AI 提示过的风险原样发出去。',
      clause: t.clause,
      quote: String((real[0] && real[0].quote) || '').slice(0, 120),
      hint: '到「意见」页采纳其中确实成立的，其余标「无需修改」并写一句理由',
      file: t.file,
    })
  }
  // 附：AI 的审核口径（提示词里的立场/类型/指令），让预检能说明"按什么标准审的"
  const aiBrief = ai.config

  const byLevel = {}
  for (const f of findings) byLevel[f.level] = (byLevel[f.level] || 0) + 1

  const total = findings.length
  log(dir, 'precheck', { files: docs.length, findings: total })
  return {
    ok: true,
    scope: 'deterministic',
    // AI 审核口径：立场 / 类型 / 用户写的审核指令 / 审核时间。
    // 预检页要能显示"这份结论是按什么标准审出来的"（用户 2026-11-01）。
    aiReview: aiReviewMeta(dir),
    // 明确声明：这是机器能判的那部分，不替代人工复核
    note: '预检只覆盖：占位符、条款编号、附件条款、关键词覆盖、签署安排。条款是否公平、风险是否可接受，仍需人工判断。',
    files: docs,
    count: total,
    byLevel,
    findings,
    summary: total
      ? `预检 ${total} 项｜` + Object.entries(byLevel).map(([k, v]) => `${k} ${v}`).join('、')
      : `预检通过：${docs.length} 份合同、${docs.reduce((n, d) => n + d.clauses, 0)} 条条款，未发现机器可判的硬伤`,
  }
}

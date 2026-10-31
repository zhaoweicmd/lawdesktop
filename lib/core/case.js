// 案件生命周期：建案、开案复述、进度台账渲染
//
// 设计要点（来自问卷与文档）：
// - 材料目录可能是只读归档（云盘/网络盘的归档目录），
//   所以「案件工作目录」与「材料目录」分开存：前者可写，后者只读登记。
// - 开工先读并复述（文档技巧④）：openCase 不是简单 dump JSON，
//   而是把「上次做到哪、什么东西还没确认」摊开，避免 agent 重新推理。

import fs from 'node:fs'
import path from 'node:path'
import {
  STATE, casePaths, readJson, readJsonl, writeJsonAtomic, writeTextAtomic,
  nowIso, log,
} from './store.js'
import { DEFAULT_REVIEW_CONFIG, normalizeReviewConfig, reviewBrief } from './contractcfg.js'
import { checkStatus } from './checkoff.js'

export const STATUS = {
  draft: 'draft',
  inProgress: 'in_progress',
  needsReview: 'needs_human_review',
  // closed 仅允许人工通过 lc_case_close 显式写入（M1 不提供该工具）
}

const pad = (n) => String(n).padStart(2, '0')

export function caseIdNow(d = new Date()) {
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const rand = Math.random().toString(16).slice(2, 6)
  return `${stamp}-${rand}`
}

function assertTitle(title) {
  const t = String(title || '').trim()
  if (!t) throw new Error('title 不能为空：至少写清这是哪个案件（如「某某公司诉某某公司买卖合同纠纷」）')
  if (t.length > 80) throw new Error(`title 过长（${t.length} 字）：请压到 80 字以内，细节写进 cause/parties`)
  return t
}

/** 进度台账渲染（人可读；程序判定仍以 case.json 为准） */
export function renderProgressMd(c) {
  const rows = (c.proc || []).map((p) => {
    const dep = p.dependsOn && p.dependsOn.length ? p.dependsOn.join('/') : '—'
    const mark = { todo: '☐', doing: '◐', done: '☑', blocked: '⛔' }[p.status] || '☐'
    return `| ${mark} ${p.id} | ${p.name} | ${dep} | ${p.status} | ${p.acceptResult ? '已验收' : '—'} |`
  })
  const total = (c.proc || []).length
  const done = (c.proc || []).filter((p) => p.status === 'done').length

  const lines = [
    `# 进度台账 · ${c.title}`,
    '',
    `> 本文件由 LawCase 维护，供人直接阅读。程序以 \`.lawcase/case.json\` 为准。`,
    '',
    `- 案件编号：\`${c.caseId}\``,
    `- 案由：${c.cause || '（未填）'}`,
    `- 当事人：${c.parties || '（未填）'}`,
    `- 建案时间：${c.createdAt}`,
    `- 当前状态：**${c.status}**`,
    `- 工序进度：${done}/${total || 0}`,
    '',
    '## 工序表',
    '',
  ]

  if (!total) {
    lines.push('（尚未生成工序表。下一步：让 agent 用 `lc_proc_plan` 提交工序拆解。）')
  } else {
    lines.push('| 工序 | 名称 | 依赖 | 状态 | 验收 |', '|---|---|---|---|---|', ...rows)
  }

  lines.push('', '## 待确认', '')
  const pend = c.pendingConfirm || []
  if (!pend.length) lines.push('（无）')
  else for (const q of pend) lines.push(`- [ ] ${q}`)

  lines.push('', '## 变更记录', '')
  lines.push('（工序状态变更会追加到 `.lawcase/log.jsonl`，此处只留摘要。）')
  lines.push('')
  return lines.join('\n')
}

/** 结论台账渲染（空模板：空着比写错好） */
export function renderConclusionMd(c, findings = []) {
  const rows = findings.map((f) => {
    const facts = (f.factRefs || []).join('、') || '（无）'
    const law = f.law ? (f.lawSource && f.lawSource.locator ? `${f.law}｜${f.lawSource.locator}` : f.law) : '—'
    const st = f.status === 'accepted' ? '已确认' : '草稿'
    return `| ${f.id} | ${f.text} | ${facts} | ${law} | ${st} |`
  })
  const lines = [
    `# 结论台账 · ${c.title}`,
    '',
    '> 每条结论必须能追到事实编号（F#）与依据来源。写不出依据就留空，**空着比写错好**。',
    '> 本文件不产出法律意见，只记录「已核到哪一步」。',
    '',
    '## 结论',
    '',
    '| # | 结论 | 支撑事实 | 法律依据 | 状态 |',
    '|---|---|---|---|---|',
  ]
  if (!rows.length) lines.push('| — | （待填） | | | |')
  else lines.push(...rows)
  lines.push(
    '',
    '## 待人工确认',
    '',
    findings.length ? `（${findings.length} 条结论均为草稿，需人工逐条确认后才可外发）` : '（无）',
    '',
  )
  return lines.join('\n')
}

/**
 * 建案。
 * @param {{dir:string,title:string,cause?:string,parties?:string,materialsDirs?:string[]}} input
 */
export function newCase({ dir, title, cause = '', parties = '', materialsDirs = [], caseType = 'litigation' }) {
  const caseDir = path.resolve(String(dir || ''))
  if (!dir) throw new Error('dir 不能为空：请给出案件工作目录的绝对路径（产出会写在这里）')

  const p = casePaths(caseDir)
  if (fs.existsSync(p.caseJson)) {
    throw new Error(
      `该目录已存在 LawCase 案件（${path.join(STATE, 'case.json')}）。` +
      `不覆盖：请换个目录，或用 lc_case_open 打开已有案件。`
    )
  }

  // 案件总目录不能自己变成案件：一旦 .lawcase 落在「放所有案件的那一层」，
  // 这一层既是案件又是根目录，列表就会把它和里面的案件搅在一起。
  // 当场拦住并说清该怎么填，比事后让人去翻 .trash 强。
  const innerCases = (() => {
    try {
      return fs
        .readdirSync(caseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .filter((d) => fs.existsSync(path.join(caseDir, d.name, STATE, 'case.json')))
        .map((d) => d.name)
    } catch (e) {
      return []
    }
  })()
  if (innerCases.length > 0) {
    throw new Error(
      `这个目录下面已经有 ${innerCases.length} 个案件（${innerCases.slice(0, 3).join('、')}${innerCases.length > 3 ? ' 等' : ''}），` +
      `它看起来是「案件总目录」，不该再当案件本身用。` +
      `请把案件名称对应到它下面的一个子目录（建案会自动生成），或换一个空目录。`
    )
  }

  // 材料目录只登记，不做可写性要求（归档目录通常只读）
  const matDirs = (Array.isArray(materialsDirs) ? materialsDirs : [])
    .filter(Boolean)
    .map((d) => path.resolve(d))
    .filter((d) => {
      try { return fs.statSync(d).isDirectory() } catch (e) { return false }
    })

  fs.mkdirSync(p.state, { recursive: true })
  fs.mkdirSync(p.cache, { recursive: true })

  const TYPE = String(caseType || 'litigation').trim()
  if (!['litigation', 'contract'].includes(TYPE)) {
    throw new Error(`案型只能是 litigation（诉讼/争议）或 contract（合同审核），收到「${caseType}」`)
  }
  const c = {
    schema: 1,
    caseId: caseIdNow(),
    // 案型决定验收判据：诉讼看事实能否追到出处，合同审核看条款是否逐条审过、意见能否直接改。
    caseType: TYPE,
    title: assertTitle(title),
    cause: String(cause || '').trim(),
    parties: String(parties || '').trim(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: STATUS.draft,
    proc: [],
    factsSeq: 0,
    findingsSeq: 0,
    materialsDirs: matDirs,
    materials: { files: [], scannedAt: null },
    confirmed: { procPlan: false },
    // 合同审核案：审核立场/类型/补充要求。诉讼案留着也无害（不影响判据）
    review: { ...DEFAULT_REVIEW_CONFIG, updatedAt: null },
    pendingConfirm: [
      '确认本案的工序拆解（哪些工序、依赖关系、验收标准）',
      '确认材料目录清单（只读来源与产出位置）',
    ],
  }

  writeJsonAtomic(p.caseJson, c)
  writeTextAtomic(p.progress, renderProgressMd(c))
  writeTextAtomic(p.conclusion, renderConclusionMd(c))
  // 台账文件先建空的：文件即状态，目录里看得见才叫「已开工」
  if (!fs.existsSync(p.facts)) writeTextAtomic(p.facts, '')
  if (!fs.existsSync(p.findings)) writeTextAtomic(p.findings, '')
  log(caseDir, { op: 'case_new', caseId: c.caseId, title: c.title })

  return {
    caseId: c.caseId,
    dir: caseDir,
    state: p.state,
    status: c.status,
    materialsDirs: matDirs,
    files: {
      case: p.caseJson,
      progress: p.progress,
      conclusion: p.conclusion,
      facts: p.facts,
      log: p.log,
    },
    nextSteps: [
      '把本案要做的工序写出来，用 lc_proc_plan 提交（四列：工序/输入/输出/验收；标依赖）',
      '确认材料目录，用 lc_material_scan 登记材料（只读来源不会被写入）',
    ],
  }
}

function countBy(arr, key) {
  const out = {}
  for (const x of arr) {
    const k = x && x[key] != null ? String(x[key]) : 'unknown'
    out[k] = (out[k] || 0) + 1
  }
  return out
}

/**
 * 开案：把状态摊开给 agent（开工复述）。
 * 不改变任何状态，纯读。
 */
export function openCase({ case: caseDirRaw }) {
  const caseDir = path.resolve(String(caseDirRaw || ''))
  if (!caseDirRaw) throw new Error('case 不能为空：请给出案件工作目录绝对路径')

  const p = casePaths(caseDir)
  const c = readJson(p.caseJson, null)
  if (!c) throw new Error(`该目录不是 LawCase 案件（缺少 ${path.join(STATE, 'case.json')}）：${caseDir}`)

  // 事实按 id 合并：修正（lc_fact_amend）是追加覆盖，直接数行数会把同一条算两遍
  // （某案原始 190 行，真实只有 81 条）。findings 同理。
  const factById = new Map()
  for (const f of readJsonl(p.facts)) {
    if (f.__broken || !f.id) continue
    factById.set(f.id, { ...(factById.get(f.id) || {}), ...f })
  }
  const factsAll = [...factById.values()]
  const facts = factsAll.filter((f) => !f.__revoked)
  const brokenLines = readJsonl(p.facts).filter((f) => f.__broken).length
  const findingById = new Map()
  for (const f of readJsonl(p.findings)) {
    if (f.__broken || !f.id) continue
    findingById.set(f.id, { ...(findingById.get(f.id) || {}), ...f })
  }
  const findings = [...findingById.values()].filter((f) => !f.__revoked)
  const mats = readJson(p.materials, null) || { files: [] }
  const logs = readJsonl(p.log)

  const proc = c.proc || []
  const doing = proc.find((x) => x.status === 'doing') || null
  const blocked = proc.filter((x) => x.status === 'blocked')
  // 「已核对」只认 checkoff（逐条核对台账）：verified 是历史字段，checkoff 从不写它
  let checkedFactIds = new Set()
  let factCheckTotal = facts.length
  try {
    if (typeof checkStatus !== 'function') throw new Error('checkStatus 未加载')
    const ck = checkStatus({ case: caseDir })
    checkedFactIds = new Set((ck.items || []).filter((x) => x.kind === 'fact' && x.result === 'ok').map((x) => x.id))
    if (ck.kinds && ck.kinds.fact) factCheckTotal = ck.kinds.fact.total
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) console.warn('lawcase: 读取核对台账失败', e && e.message)
  }
  const unverified = facts.length - facts.filter((f) => checkedFactIds.has(f.id)).length

  const lastLog = logs.length ? logs[logs.length - 1] : null

  // 下一步建议：按「阻塞项 > 未确认 > 进行中 > 未开工」排
  const hints = []
  if (blocked.length) hints.push(`有 ${blocked.length} 道工序被标 blocked（${blocked.map((b) => b.id).join('、')}），先解阻塞`)
  const pend = c.pendingConfirm || []
  if (pend.length) hints.push(`有 ${pend.length} 项待确认，开工前应先向用户复述并确认`)
  if (unverified) hints.push(`有 ${unverified} 条事实未核到出处（${facts.filter((f) => f.verified === 'broken').length} 条来源失效），汇报前需处理`)
  if (!proc.length) hints.push('工序表为空：先 lc_proc_plan')
  else if (doing) hints.push(`当前进行中：${doing.id} ${doing.name}`)
  else {
    const nextTodo = proc.find((x) => x.status === 'todo' && (x.dependsOn || []).every((d) => (proc.find((y) => y.id === d) || {}).status === 'done'))
    if (nextTodo) hints.push(`可开工：${nextTodo.id} ${nextTodo.name}`)
  }
  if (!mats.files || !mats.files.length) hints.push('材料未登记：先 lc_material_scan')

  return {
    caseId: c.caseId,
    caseType: c.caseType || 'litigation',
    caseTypeLabel: (c.caseType || 'litigation') === 'contract' ? '合同审核' : '诉讼/争议',
    // 合同审核案必须一眼看出"这份意见是替谁审的"，否则复核时无法判断口径
    review: { ...normalizeReviewConfig(c.review), brief: reviewBrief(c.review) },
    title: c.title,
    cause: c.cause,
    parties: c.parties,
    dir: caseDir,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    proc: {
      total: proc.length,
      done: proc.filter((x) => x.status === 'done').length,
      doing: doing ? `${doing.id} ${doing.name}` : null,
      blocked: blocked.map((b) => b.id),
      rows: proc.map((x) => ({ id: x.id, name: x.name, status: x.status, dependsOn: x.dependsOn || [] })),
    },
    facts: { total: facts.length, ok: facts.length - unverified, unverified, brokenLines },
    findings: { total: findings.length, byLevel: countBy(findings, 'level') },
    materials: {
      dirs: c.materialsDirs || [],
      total: (mats.files || []).length,
      parsed: (mats.files || []).filter((f) => f.parsed).length,
      lastScanAt: mats.scannedAt || null,
    },
    pendingConfirm: pend,
    lastLog,
    hints,
  }
}

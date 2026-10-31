// AI 审核的编排：读案件 → 组提示词 → 调模型 → 确定性校验 → 暂存草稿 → 留审计。
//
// 这一层是「点按钮就出草稿」的全部逻辑，界面与工具都只是壳。
//
// 三条不可让步的规则（文档第七、八、九章）：
//   1) **服务端自己读案件**：绝不拿前端提交的合同全文当唯一来源，范围以 clauses.json 为准。
//   2) **会话必须对得上案件**：绑定了别的案就拒绝，防止草稿写错案卷。
//   3) **失败就是失败**：模型超时/非 JSON/取消/token 上限，一律不落「无风险」结论。

import fs from 'node:fs'
import path from 'node:path'

import { casePaths, readJson, writeJsonAtomic, nowIso, log } from './store.js'
import { loadClauses, loadNotes, loadDrafts, QUOTE_MIN } from './clause.js'
import { readReviewConfig, reviewBrief, normalizeReviewConfig } from './contractcfg.js'
import { getBinding } from './sessionbind.js'
import { buildSystemPrompt, buildReviewMessage, chunkClauses, PROMPT_VERSION, MAX_CONTRACT_CHARS } from './aiprompt.js'
import { validateModelOutput } from './aivalidate.js'
import { callModel, parseJsonObject } from './llmcall.js'
import { resolveSelection, selectionLabel, REVIEW_PURPOSE } from './models.js'

const sha256 = async (buf) => {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(buf).digest('hex')
}

function err(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function draftsPath(dir) {
  return path.join(casePaths(dir).state, 'note-drafts.json')
}

function auditPath(dir) {
  return path.join(casePaths(dir).state, 'ai-review.jsonl')
}

/** 合同文件指纹：交付包与审计要靠它证明"审的是哪一版" */
async function contractFingerprint(target) {
  const out = { file: target.name, path: String(target.file || ''), sha256: '', bytes: 0, clauseCount: Array.isArray(target.clauses) ? target.clauses.length : 0 }
  try {
    if (target.file && fs.existsSync(target.file)) {
      const buf = fs.readFileSync(target.file)
      out.sha256 = await sha256(buf)
      out.bytes = buf.length
    }
  } catch (e) {
    /* 指纹取不到不影响审核，只是审计里少一项 */
  }
  // 没有源文件时（条款索引来自别的途径）用条款文本本身算指纹，保证可比
  if (!out.sha256) {
    const body = (target.clauses || []).map((c) => `${c.no}\n${c.text}`).join('\n\u0000\n')
    out.sha256 = await sha256(Buffer.from(body, 'utf8'))
    out.bytes = Buffer.byteLength(body, 'utf8')
    out.fromClauses = true
  }
  return out
}

/** 口径指纹：立场/类型/补充要求/规则集一起算，便于回答「这次和上次口径一样吗」 */
async function configFingerprint(cfg) {
  const body = JSON.stringify({ stance: cfg.stance, templateId: cfg.templateId, instructions: cfg.instructions, prompt: PROMPT_VERSION })
  return sha256(Buffer.from(body, 'utf8'))
}

/**
 * 选合同：不传就取最后索引的那份（与 worksheet/validateDrafts 一致）。
 */
function pickContract(dir, file) {
  const files = loadClauses(dir)
  if (!files.length) throw err('contract/none', '还没有索引合同：先在「条款」页把合同切成条款，再开始审核。')
  const target = file ? files.find((x) => x.name === file || x.file === file) : files[files.length - 1]
  if (!target) throw err('contract/missing', `条款索引里没有这份文件：${file}`)
  if (!Array.isArray(target.clauses) || !target.clauses.length) {
    throw err('contract/empty', `《${target.name}》的条款索引是空的：请重新索引后再审核。`)
  }
  return target
}

/**
 * 会话 ↔ 案件双重校验。
 *
 * 为什么两条都要：
 *   · 绑定：同一会话切到另一个案卷去审 = 草稿可能写错地方（这个坑真出现过）
 *   · 未绑定：工作台按案卷开会话时通常还没绑过，此时只要求「不许已被别案占用」
 */
export function assertSessionMayReview({ dir, sessionId, pkgRoot }) {
  const sid = String(sessionId || '').trim()
  if (!sid) return { bound: false, sessionId: '' }
  const b = getBinding(sid, { pkgRoot })
  if (b && b.case && path.resolve(b.case) !== path.resolve(dir)) {
    throw err(
      'session/other-case',
      `这个会话绑定的是另一个案件：${b.case}。当前案件是 ${dir}。` +
        '为防止草稿写错案卷，已拒绝本次 AI 审核；请在目标案件的会话里操作，或先解除旧绑定。'
    )
  }
  return { bound: Boolean(b), sessionId: sid, case: b ? b.case : null }
}

/**
 * 执行一次 AI 审核。
 *
 * @param {object} p
 * @param {string} p.case    案件目录
 * @param {string} [p.file]  合同文件名
 * @param {string} [p.sessionId]
 * @param {object} [p.modelSelection] {provider, model}；空=跟随默认
 * @param {string} [p.stance] / [p.templateId] / [p.instructions] 本次口径（不传则用案件里存的）
 * @param {object} p.llm      宿主 llm 服务
 * @param {object} [p.defaultModel] 宿主 agentDefaultModel
 * @param {AbortSignal} [p.signal]
 * @param {number} [p.timeoutMs]
 * @param {string} [p.pkgRoot]
 * @param {(op:string, data:object)=>void} [p.onProgress] 阶段回调（界面显示"模型调用中/解析校验中"）
 */
export async function runAiReview({
  case: caseDirRaw,
  file,
  sessionId,
  modelSelection,
  stance,
  templateId,
  instructions,
  llm,
  defaultModel,
  signal,
  timeoutMs,
  pkgRoot,
  onProgress,
} = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const cp = casePaths(dir)
  if (!readJson(cp.caseJson, null)) throw err('case/not-a-case', `不是 LawCase 案件：${dir}`)

  const stage = (s, extra) => {
    try {
      if (typeof onProgress === 'function') onProgress(s, extra || {})
    } catch (e) {}
  }

  stage('prepare')
  assertSessionMayReview({ dir, sessionId, pkgRoot })

  const target = pickContract(dir, file)

  // 口径：调用方传来的字段覆盖案件里存的（不传就沿用），然后**落盘**——
  // 文档 4.7 要求 case.json 保存 review 与 modelSelection，复核的人才知道这次按什么口径审的。
  const prevCfg = readReviewConfig(dir)
  const cfg = normalizeReviewConfig({
    stance: stance === undefined ? prevCfg.stance : stance,
    templateId: templateId === undefined ? prevCfg.templateId : templateId,
    instructions: instructions === undefined ? prevCfg.instructions : instructions,
    updatedAt: nowIso(),
  })

  const sel = await resolveSelection({ modelSelection, llm, defaultModel })
  const label = selectionLabel(sel, { providerName: sel.providerName })

  const notes = loadNotes(cp).filter((n) => n && n.file === target.name)
  const ws = {
    file: target.name,
    items: target.clauses.map((c) => ({
      clause: c.no,
      heading: c.heading,
      chars: c.chars,
      noteCount: notes.filter((n) => String(n.clause) === String(c.no)).length,
      sentences: String(c.text || '')
        .split(/(?<=[。；;！？?])/)
        .map((s) => s.trim())
        .filter((s) => s.length >= QUOTE_MIN),
      text: c.text,
    })),
  }

  const system = buildSystemPrompt()
  const fp = await contractFingerprint(target)
  const cfgFp = await configFingerprint(cfg)
  const startedAt = nowIso()
  const reviewId = `R${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

  // ---- 分批策略 ----------------------------------------------------------
  // 分批的目的是**提示词预算**（一次塞不下整份合同），不是为了赶时间。
  // 2026-11-01 起不再设 120 秒墙钟上限：大合同按时间掐断只会更慢
  //（被掐断→切批→批更多→更容易超时）。真卡死由界面的「取消」按钮中止。
  // 若调用方显式传 timeoutMs，就仍按它切批重试（测试与强制上限时用）。
  const chunkPlan = chunkClauses(ws.items, { maxChars: MAX_CONTRACT_CHARS })
  const batches = [] // 每批的执行结果
  let batchNo = 0

  /**
   * 跑一批；超时就把它对半切开重跑。
   * @returns {{ok:true, parsed:object, items:Array} | {ok:false, code:string, message:string}}
   */
  async function runBatch(items, depth = 0) {
    batchNo += 1
    const seq = batchNo
    stage(items.length > 1 ? 'model' : 'model', {
      model: label,
      reviewId,
      batch: seq,
      batchTotal: batches.length || chunkPlan.length,
      clauseFrom: items[0] && items[0].clause,
      clauseTo: items[items.length - 1] && items[items.length - 1].clause,
    })

    const wsPart = { file: ws.file, items }
    const message = buildReviewMessage({ file: target.name, worksheet: wsPart, config: cfg, notes })
    const r = await callModel({
      llm,
      selection: sel,
      system,
      user: message.text,
      sessionId,
      signal,
      timeoutMs,
    })

    if (r.ok) {
      const parsed = parseJsonObject(r.text)
      if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message, items }
      return { ok: true, parsed: parsed.value, items }
    }

    // 超时且这批还有多条：对半切开接着审（这就是"继续审"）
    if (r.code === 'model/timeout' && items.length > 1 && depth < 6) {
      const mid = Math.ceil(items.length / 2)
      const head = items.slice(0, mid)
      const tail = items.slice(mid)
      log(dir, { op: 'ai-review-split', reviewId, clauses: items.length, into: [head.length, tail.length], depth })
      const a = await runBatch(head, depth + 1)
      if (!a.ok) return a
      const b = await runBatch(tail, depth + 1)
      if (!b.ok) return b
      // 两半的 issues/skipped 合并成同一份输出
      return {
        ok: true,
        parsed: {
          issues: [...(Array.isArray(a.parsed.issues) ? a.parsed.issues : []), ...(Array.isArray(b.parsed.issues) ? b.parsed.issues : [])],
          skipped: [...(Array.isArray(a.parsed.skipped) ? a.parsed.skipped : []), ...(Array.isArray(b.parsed.skipped) ? b.parsed.skipped : [])],
        },
        items,
        split: true,
      }
    }
    return { ok: false, code: r.code, message: r.message, items }
  }

  stage('calling', { model: label, reviewId, batchTotal: chunkPlan.length })

  // 逐批跑；任何一批彻底失败就整体失败（不许出半份审核结论）
  const merged = { issues: [], skipped: [] }
  let anySplit = false
  let failed = null
  for (const plan of chunkPlan) {
    const got = await runBatch(plan.items)
    if (!got.ok) {
      failed = got
      break
    }
    if (got.split) anySplit = true
    if (Array.isArray(got.parsed.issues)) merged.issues.push(...got.parsed.issues)
    if (Array.isArray(got.parsed.skipped)) merged.skipped.push(...got.parsed.skipped)
    batches.push({ clauses: plan.items.length, ok: true })
  }

  const resp = failed
    ? { ok: false, code: failed.code, message: `第 ${batches.length + 1} 批（${failed.items.length} 条条款）失败：${failed.message}`, reviewId }
    : { ok: true, parsed: merged }
  const totalBatches = batchNo
  const splitNote = anySplit ? `（其中出现超时，已自动切批继续审，共调用 ${totalBatches} 次）` : ''

  // 失败：写审计（失败也是事实，要留痕），**不写草稿**，把错误原样交回去
  if (!resp.ok) {
    const rec = {
      reviewId,
      at: startedAt,
      finishedAt: nowIso(),
      status: 'failed',
      code: resp.code,
      message: resp.message,
      model: { provider: sel.provider, model: sel.model, label },
      stance: cfg.stance,
      templateId: cfg.templateId,
      instructions: cfg.instructions,
      promptVersion: PROMPT_VERSION,
      contract: fp,
      configFingerprint: cfgFp,
      sessionId: sessionId || '',
      purpose: REVIEW_PURPOSE,
      truncated: false,
      batches: totalBatches,
    }
    appendAudit(dir, rec)
    log(dir, { op: 'ai-review-failed', reviewId, code: resp.code })
    return { ok: false, code: resp.code, message: resp.message, reviewId, model: rec.model, config: { brief: reviewBrief(cfg), ...cfg } }
  }

  stage('validating', { reviewId })

  // 解析已经在每一批里做过了（分批时每批各自解析、再合并）；
  // 外层不用再 parse 一次，避免"同一份文本两套解析结果"的困惑。
  const parsed = { ok: resp.ok, value: resp.parsed }
  if (!parsed.ok) {
    const rec = {
      reviewId,
      at: startedAt,
      finishedAt: nowIso(),
      status: 'failed',
      code: resp.code,
      message: resp.message,
      model: { provider: sel.provider, model: sel.model, label },
      stance: cfg.stance,
      templateId: cfg.templateId,
      instructions: cfg.instructions,
      promptVersion: PROMPT_VERSION,
      contract: fp,
      configFingerprint: cfgFp,
      sessionId: sessionId || '',
      purpose: REVIEW_PURPOSE,
      truncated: false,
      rawHead: String(resp.text || '').slice(0, 400),
    }
    appendAudit(dir, rec)
    log(dir, { op: 'ai-review-failed', reviewId, code: resp.code })
    return { ok: false, code: parsed.code, message: parsed.message, reviewId, model: rec.model, config: { brief: reviewBrief(cfg), ...cfg } }
  }

  const checked = validateModelOutput({ parsed: parsed.value, clauses: target.clauses })
  if (!checked.ok) {
    const rec = {
      reviewId,
      at: startedAt,
      finishedAt: nowIso(),
      status: 'failed',
      code: checked.code,
      message: checked.message,
      model: { provider: sel.provider, model: sel.model, label },
      stance: cfg.stance,
      templateId: cfg.templateId,
      instructions: cfg.instructions,
      promptVersion: PROMPT_VERSION,
      contract: fp,
      configFingerprint: cfgFp,
      sessionId: sessionId || '',
      purpose: REVIEW_PURPOSE,
      truncated: false,
    }
    appendAudit(dir, rec)
    log(dir, { op: 'ai-review-failed', reviewId, code: checked.code })
    return { ok: false, code: checked.code, message: checked.message, reviewId, model: rec.model, config: { brief: reviewBrief(cfg), ...cfg } }
  }

  stage('saving', { reviewId })

  const at = nowIso()
  const drafts = {
    file: target.name,
    at,
    reviewId,
    promptVersion: PROMPT_VERSION,
    model: { provider: sel.provider, model: sel.model, label },
    config: { brief: reviewBrief(cfg), stance: cfg.stance, templateId: cfg.templateId, instructions: cfg.instructions },
    contract: fp,
    truncated: false,
    clauseCount: ws.items.length,
    drafts: checked.issues.map((x) => ({
      clause: x.clause,
      heading: x.clauseHeading,
      level: x.level,
      severity: x.severity,
      title: x.title,
      issue: x.issue,
      fix: x.fix,
      quote: x.quote,
      basis: '',
      quoteOk: x.quoteOk,
      quoteWhere: x.quoteWhere,
      located: x.located,
      status: x.status,
      ok: x.status === 'ok',
      problems: x.problems,
      warnings: x.warnings,
      reviewId,
      from: 'ai',
    })),
    skipped: checked.skipped,
    dropped: checked.dropped,
    counts: checked.counts,
  }
  writeJsonAtomic(draftsPath(dir), drafts)

  const rec = {
    reviewId,
    at: startedAt,
    finishedAt: at,
    status: 'ok',
    model: { provider: sel.provider, model: sel.model, label },
    stance: cfg.stance,
    templateId: cfg.templateId,
    instructions: cfg.instructions,
    promptVersion: PROMPT_VERSION,
    contract: fp,
    configFingerprint: cfgFp,
    sessionId: sessionId || '',
    purpose: REVIEW_PURPOSE,
    truncated: false,
    clauseCount: ws.items.length,
    counts: checked.counts,
  }
  appendAudit(dir, rec)
  log(dir, { op: 'ai-review', reviewId, counts: checked.counts, model: label, batches: totalBatches })

  const warnings = []
  // 分批之后不存在"截断"：每一批都覆盖到各自的条款，合起来就是全部。
  // 这里换成"分了几批"的说明 —— 费用与耗时要让人看得见。
  if (totalBatches > 1) {
    warnings.push(`合同较长，已分 ${chunkPlan.length} 批审核（共调用模型 ${totalBatches} 次${anySplit ? '，其中含超时自动切批' : ''}）。`)
  }
  if (checked.counts.fail) warnings.push(`${checked.counts.fail} 条因校验不通过被拒收，未进入草稿列表。`)
  if (checked.counts.warn) warnings.push(`${checked.counts.warn} 条引文没能逐字命中，标为「待人工确认」，不能一键采纳。`)

  return {
    ok: true,
    reviewId,
    file: target.name,
    model: { provider: sel.provider, model: sel.model, label, source: sel.source },
    config: { brief: reviewBrief(cfg), stance: cfg.stance, templateId: cfg.templateId, instructions: cfg.instructions },
    contract: fp,
    counts: checked.counts,
    drafts: drafts.drafts,
    skipped: checked.skipped,
    dropped: checked.dropped,
    truncated: false,
    // 分批后没有"一条"提示词：报批数与覆盖条款数更有用
    prompt: { promptVersion: PROMPT_VERSION, batches: totalBatches, clauseCount: ws.items.length },
    warnings,
    summary: checked.summary + `｜模型：${label}`,
    at,
  }
}

/** 追加一条审计（不覆盖历史）：.lawcase/ai-review.jsonl */
function appendAudit(dir, rec) {
  try {
    const p = auditPath(dir)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(rec) + '\n', 'utf8')
  } catch (e) {
    /* 审计写失败不影响本次结果，但会让交付包少一条记录 */
  }
}

/** 读审计记录（最近 N 条，新的在前）。纯读。 */
export function loadAiAudit({ case: caseDirRaw, limit = 20 } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const p = auditPath(dir)
  const out = []
  try {
    const text = fs.readFileSync(p, 'utf8')
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        out.push(JSON.parse(t))
      } catch (e) {}
    }
  } catch (e) {
    return { ok: true, count: 0, items: [], summary: '还没有 AI 审核记录' }
  }
  const items = out.slice(-Math.max(1, Number(limit) || 20)).reverse()
  return {
    ok: true,
    count: out.length,
    items,
    summary: `共 ${out.length} 次 AI 审核，最近一次 ${items.length ? items[0].at : '无'}`,
  }
}

/** 读回草稿（含模型、口径、指纹）：界面展开「本次审核来源」用 */
export function loadDraftsDetail({ case: caseDirRaw } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const d = readJson(draftsPath(dir), null)
  if (!d) return { ok: true, count: 0, drafts: [], summary: '还没有 AI 草稿' }
  return {
    ok: true,
    file: d.file || '',
    at: d.at || '',
    reviewId: d.reviewId || '',
    model: d.model || null,
    config: d.config || null,
    contract: d.contract || null,
    truncated: Boolean(d.truncated),
    count: Array.isArray(d.drafts) ? d.drafts.length : 0,
    counts: d.counts || null,
    drafts: Array.isArray(d.drafts) ? d.drafts : [],
    skipped: Array.isArray(d.skipped) ? d.skipped : [],
    dropped: Array.isArray(d.dropped) ? d.dropped : [],
    summary:
      `${d.file || ''}：AI 草稿 ${Array.isArray(d.drafts) ? d.drafts.length : 0} 条` +
      (d.model ? `｜模型：${(d.model && d.model.label) || d.model.model}` : '') +
      (d.config && d.config.brief ? `｜口径：${d.config.brief}` : ''),
  }
}

export const _internals = { sha256, contractFingerprint, configFingerprint, pickContract, draftsPath, auditPath }

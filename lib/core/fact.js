import fs from 'node:fs'
import path from 'node:path'
import { casePaths, readJsonl, appendJsonl, readJson, mutateCase, nowIso, log } from './store.js'
import { checkStatus } from './checkoff.js'

const SENT_SPLIT = /(?<=[。！？；!?;])\s*|\n+/

function resolveSource(dir, cp, src) {
  const raw = String(src || '').trim()
  if (!raw) throw new Error('出处文件名必填（--source）')
  // 允许直接给材料编号 M3
  if (/^M\d+$/i.test(raw)) {
    const doc = readJson(cp.materials, null)
    const m = doc && (doc.files || []).find((f) => f.mid.toUpperCase() === raw.toUpperCase())
    if (!m) throw new Error(`材料编号 ${raw} 不在登记表里，先跑 lc_material_scan`)
    return { file: m.rel, abs: m.abs, materialId: m.mid }
  }
  const abs = path.isAbsolute(raw) ? raw : path.resolve(dir, raw)
  return { file: raw, abs, materialId: null }
}

/**
 * 登记一条事实。出处必填；编号自动递增。
 * @param {{case:string, text:string, source:string, locator:string, confirmed?:boolean, note?:string}} args
 */
export function addFact({ case: caseDirRaw, text, source, locator, quote, confirmed = false, note = '' }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const body = String(text || '').trim()
  if (!body) throw new Error('事实内容不能为空')
  if (body.length < 4) throw new Error('事实内容过短（<4 字），写完整一点')
  if (body.length > 1000) throw new Error('事实内容过长（>1000 字），拆成多条')

  const loc = String(locator || '').trim()
  if (!loc) throw new Error('定位必填（页码/段落/表格行列/录音时间），没有定位就无法回溯')

  const src = resolveSource(dir, cp, source)
  if (!fs.existsSync(src.abs)) throw new Error(`出处文件不存在：${src.file}`)

  let created = null
  const doc = mutateCase(dir, (d) => {
    d.factsSeq = (d.factsSeq || 0) + 1
    created = {
      id: 'F' + d.factsSeq,
      text: body,
      source: { file: src.file, locator: loc, materialId: src.materialId || undefined },
      quote: quote ? String(quote).trim() : undefined,
      verified: confirmed ? 'ok' : undefined,
      verifiedAt: confirmed ? nowIso() : undefined,
      note: note || undefined,
      createdAt: nowIso(),
    }
    return d
  })
  void doc
  appendJsonl(cp.facts, created)
  log(dir, { op: 'fact-add', id: created.id, file: src.file, verified: created.verified || 'pending' })

  const total = readJsonl(cp.facts).filter((f) => !f.__broken).length
  return {
    ok: true,
    fact: created,
    total,
    summary: `${created.id} 已登记（${src.file} · ${loc}）｜${confirmed ? '已复核' : '待复核'}｜台账共 ${total} 条`,
  }
}

export function listFacts({ case: caseDirRaw, pendingOnly = false }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const { active: all, revoked } = loadFacts(dir)
  // 「已核对」只认 checkoff（逐条核对台账）——那是签字依据。
  // verified 是历史字段（addFact 的 confirmed 参数写的），再拿它统计会和面板对不上。
  let checked = new Set()
  try {
    if (typeof checkStatus !== 'function') throw new Error('checkStatus 未加载（模块循环或导入缺失）')
    const ck = checkStatus({ case: dir })
    checked = new Set((ck.items || []).filter((x) => x.kind === 'fact' && x.result === 'ok').map((x) => x.id))
  } catch (e) {
    // 不能静默吞：吞掉的后果是「已核」永远显示 0，用户以为核对记录丢了
    if (typeof console !== 'undefined' && console.warn) console.warn('lawcase: 读取核对台账失败', e && e.message)
  }
  const isChecked = (f) => checked.has(f.id)
  const pending = all.filter((f) => !isChecked(f))
  const shown = pendingOnly ? pending : all
  return {
    ok: true,
    total: all.length,
    verified: all.filter(isChecked).length,
    pending: pending.length,
    broken: all.filter((f) => f.verified === 'broken').length,
    revoked: revoked.length,
    facts: shown.map((f) => ({
      id: f.id,
      text: f.text,
      file: f.source && f.source.file,
      locator: f.source && f.source.locator,
      // 面板用它显示「已核/待核」：统一成核对台账的状态
      verified: isChecked(f) ? 'ok' : f.verified === 'broken' ? 'broken' : 'pending',
    })),
    summary: all.length
      ? `事实 ${all.length} 条：已核 ${all.filter(isChecked).length}，待核 ${pending.length}，失效 ${all.filter((f) => f.verified === 'broken').length}`
      : '事实台账为空（用 lc_fact_add 逐条登记）',
  }
}

/**
 * 从可读文本里抽候选事实（只支持 md/txt；docx/pdf 先用解析工具转 md）。
 * 默认 dryRun=true 只返回候选，不写入。
 */
export function draftFacts({ case: caseDirRaw, source, max = 40, dryRun = true, confirmed = false }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const src = resolveSource(dir, cp, source)
  if (!fs.existsSync(src.abs)) throw new Error(`文件不存在：${src.file}`)
  const ext = path.extname(src.abs).toLowerCase()
  if (!['.md', '.txt', '.csv'].includes(ext)) {
    throw new Error(
      `只支持从 .md/.txt/.csv 抽候选（当前 ${ext || '无扩展名'}）。` +
        'docx/pdf 请先用解析工具（如 dsh-pdf-mineru 的 read_pdf）转成 md，再抽。',
    )
  }
  const raw = fs.readFileSync(src.abs, 'utf8')
  const lines = raw.split(/\r?\n/)
  const cands = []
  const seen = new Set()

  lines.forEach((line, i) => {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('<!--') || t.startsWith('|')) return
    for (const piece of t.split(SENT_SPLIT)) {
      const s = piece.trim().replace(/^[-*+]\s+/, '')
      if (s.length < 12 || s.length > 200) continue
      if (!/[\u4e00-\u9fa5]/.test(s)) continue
      if (seen.has(s)) continue
      seen.add(s)
      cands.push({ text: s, locator: `L${i + 1}` })
      if (cands.length >= max) return
    }
  })

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      file: src.file,
      candidates: cands,
      summary: `从 ${src.file} 抽到 ${cands.length} 条候选（未写入）。确认后用 lc_fact_add 逐条登记。`,
    }
  }

  let added = []
  for (const c of cands) {
    const r = addFact({
      case: caseDirRaw,
      text: c.text,
      source: src.materialId || src.file,
      locator: c.locator,
      confirmed,
      note: '批量抽取',
    })
    added.push(r.fact)
  }
  return { ok: true, dryRun: false, file: src.file, added: added.length, facts: added.map((f) => f.id), summary: `批量登记 ${added.length} 条（${confirmed ? '已复核' : '待复核'}）` }
}

/** 事实台账的有效视图：同一 id 取最后一条，__revoked 的标为失效并从有效集剔除
 *  —— 事实会写错、会撤回，台账必须允许「作废」而不是删行。 */
export function loadFacts(dir) {
  const cp = casePaths(dir)
  const raw = readJsonl(cp.facts).filter((f) => !f.__broken)
  const byId = new Map()
  for (const f of raw) {
    if (!f.id) continue
    byId.set(f.id, { ...(byId.get(f.id) || {}), ...f })
  }
  const all = [...byId.values()]
  const active = all.filter((f) => !f.__revoked)
  const revoked = all.filter((f) => f.__revoked)
  return { all, active, revoked }
}

/** 作废一条事实（追加一条作废记录，不删原始行） */
export function revokeFact({ case: caseDirRaw, id, reason }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const fid = String(id || '').trim().toUpperCase()
  if (!fid) throw new Error('缺少事实编号')
  const why = String(reason || '').trim()
  if (!why) throw new Error('作废必须写理由：没有理由的作废等于篡改台账')
  const { active } = loadFacts(dir)
  const target = active.find((f) => f.id === fid)
  if (!target) throw new Error(`${fid} 不在有效事实里（可能已作废或编号不存在）`)
  appendJsonl(cp.facts, { id: fid, __revoked: true, reason: why, revokedAt: nowIso() })
  log(dir, { op: 'fact-revoke', id: fid, reason: why })
  const after = loadFacts(dir)
  return {
    ok: true, id: fid, reason: why,
    active: after.active.length, revoked: after.revoked.length,
    summary: `已作废 ${fid}（${why}）｜有效事实 ${after.active.length} 条，作废 ${after.revoked.length} 条`,
  }
}

/** 修正一条事实的出处/引文/表述（追加修正记录，不删原始行）。
 *  改出处会重置复核状态：出处变了，之前的核对结论就不成立了。 */
export function amendFact({ case: caseDirRaw, id, locator, quote, text, reason }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const fid = String(id || '').trim().toUpperCase()
  if (!fid) throw new Error('缺少事实编号')
  const why = String(reason || '').trim()
  if (!why) throw new Error('修正必须写理由：改出处不留痕，等于事后改证')
  const { active } = loadFacts(dir)
  const target = active.find((f) => f.id === fid)
  if (!target) throw new Error(`${fid} 不在有效事实里`)
  const nextLoc = locator != null && String(locator).trim() ? String(locator).trim() : target.source?.locator
  const nextQuote = quote != null ? String(quote).trim() : target.quote
  const nextText = text != null && String(text).trim() ? String(text).trim() : target.text
  if (nextLoc === target.source?.locator && nextQuote === target.quote && nextText === target.text) {
    throw new Error('没有任何改动')
  }
  const patch = {
    id: fid,
    text: nextText,
    source: { ...(target.source || {}), locator: nextLoc },
    quote: nextQuote || undefined,
    __amended: true,
    amendedAt: nowIso(),
    amendReason: why,
    verified: undefined,
    verifiedAt: undefined,
  }
  appendJsonl(cp.facts, patch)
  log(dir, { op: 'fact-amend', id: fid, locator: nextLoc, reason: why })
  return {
    ok: true, id: fid,
    from: { locator: target.source?.locator, quote: target.quote },
    to: { locator: nextLoc, quote: nextQuote },
    summary: `已修正 ${fid} 出处 → ${nextLoc}${nextQuote ? '（含原文引用）' : ''}｜复核状态已重置`,
  }
}

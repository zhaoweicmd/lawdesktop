// 条款审核状态机：把「草稿 / 意见 / 判定 / 修订」合成一个可追溯的状态。
//
// 文档 5.3 + 第八章要求的状态：
//   待审 → （AI 草稿）→ 需修改 / 无需修改 → 意见已登记 → 修订已接受/拒绝
//
// 为什么必须集中算：这四类记录分散在四个文件里（note-drafts.json、notes.jsonl、
// rulings.jsonl、redline 产物）。分开看会得出「这条到底审没审」的错觉——
// 之前就出现过「丢弃了草稿但看不出结论」「登记了意见却仍显示待审」。
//
// 本文件只读，不写任何文件。

import fs from 'node:fs'
import path from 'node:path'

import { casePaths, readJson } from './store.js'
import { loadClauses, loadNotes, loadRulings, RULING_KINDS } from './clause.js'

/** 单个条款的状态枚举（顺序即推进顺序，用于排序与统计） */
export const CLAUSE_STATES = {
  pending: { label: '待审', tone: 'idle', rank: 0 },
  draft: { label: '有 AI 草稿待处理', tone: 'warn', rank: 1 },
  norevision: { label: '已审·无需修改', tone: 'ok', rank: 2 },
  needfix: { label: '已审·需修改', tone: 'warn', rank: 3 },
  noted: { label: '意见已登记', tone: 'ok', rank: 4 },
  revised: { label: '修订已生成', tone: 'ok', rank: 5 },
}

const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, '')

/** 读最近一次 AI 草稿（只取条款号集合，不参与状态内容） */
function draftClauses(dir) {
  const d = readJson(path.join(casePaths(dir).state, 'note-drafts.json'), null)
  const set = new Map()
  for (const x of (d && Array.isArray(d.drafts) ? d.drafts : [])) {
    const k = norm(x && x.clause)
    if (!k) continue
    set.set(k, x)
  }
  return { map: set, meta: d || null }
}

/**
 * 修订产物的接受/拒绝情况。
 *
 * 修订版是"整份 docx 由已登记意见生成"的，不是逐条状态——
 * 所以这里只标「该条款是否被本次修订覆盖」，不臆造逐条接受/拒绝。
 */
function revisedClauses(dir) {
  const p = path.join(casePaths(dir).state, 'redline.json')
  const d = readJson(p, null)
  const set = new Set()
  if (d && Array.isArray(d.items)) for (const it of d.items) {
    const k = norm(it && it.clause)
    if (k) set.add(k)
  }
  return set
}

/**
 * 算一份合同的完整体检：每个条款的当前状态 + 四类记录的交叉核对。
 *
 * @param {{case:string, file?:string}} p
 */
export function clauseStateMachine({ case: caseDirRaw, file } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  if (!readJson(casePaths(dir).caseJson, null)) throw new Error(`不是 LawCase 案件：${dir}`)
  const files = loadClauses(dir)
  if (!files.length) {
    return { ok: true, total: 0, items: [], counts: {}, summary: '还没有索引合同' }
  }
  const target = file ? files.find((x) => x.name === file || x.file === file) : files[files.length - 1]
  if (!target) throw new Error(`条款索引里没有这份文件：${file}`)

  const drafts = draftClauses(dir)
  const revised = revisedClauses(dir)

  const rulingMap = new Map()
  for (const r of loadRulings({ case: dir })) {
    if (r.file && r.file !== target.name) continue
    rulingMap.set(norm(r.clause), r)
  }
  const noteMap = new Map()
  for (const n of loadNotes(casePaths(dir))) {
    if (n.file !== target.name) continue
    const k = norm(n.clause)
    noteMap.set(k, (noteMap.get(k) || 0) + 1)
  }

  const items = target.clauses.map((c) => {
    const k = norm(c.no)
    const noteCount = noteMap.get(k) || 0
    const ruling = rulingMap.get(k) || null
    const dr = drafts.map.get(k) || null

    // 判定顺序刻意如此：意见 > 判定 > 草稿 > 待审。
    // 有意见就是「需修改」（不管之前丢弃过没有——后来登记了意见说明改了主意）；
    // 有 norevision 判定就是「无需修改」；只剩草稿就是「待处理」。
    let state = 'pending'
    if (noteCount > 0) state = 'noted'
    else if (ruling && ruling.kind === 'norevision') state = 'norevision'
    else if (ruling && ruling.kind === 'revision') state = 'needfix'
    else if (dr) state = 'draft'

    // 自相矛盾的组合要显式报出来，不要静默挑一个
    const conflicts = []
    if (ruling && ruling.kind === 'norevision' && noteCount > 0) {
      conflicts.push('同一条既有「无需修改」判定，又登记了意见：两个结论打架，请作废其中一个')
    }
    if (ruling && ruling.kind === 'norevision' && dr) {
      conflicts.push('已判定「无需修改」，但仍留着 AI 草稿：重新审核会产生重复判断')
    }

    return {
      clause: c.no,
      heading: String(c.heading || '').slice(0, 80),
      chars: c.chars,
      state,
      stateLabel: CLAUSE_STATES[state].label,
      noteCount,
      ruling: ruling ? { kind: ruling.kind, label: RULING_KINDS[ruling.kind] ? RULING_KINDS[ruling.kind].label : ruling.kind, reason: ruling.reason, by: ruling.by, at: ruling.at } : null,
      draft: dr
        ? { level: dr.level, title: dr.title || '', status: dr.status || (dr.ok ? 'ok' : 'warn'), quoteOk: dr.quoteOk, problems: dr.problems || [], warnings: dr.warnings || [] }
        : null,
      revised: revised.has(k),
      conflicts,
    }
  })

  const counts = {}
  for (const s of Object.keys(CLAUSE_STATES)) counts[s] = 0
  for (const it of items) counts[it.state] += 1
  const conflicts = items.filter((x) => x.conflicts.length)

  return {
    ok: true,
    file: target.name,
    total: items.length,
    counts,
    done: counts.noted + counts.norevision + counts.needfix,
    pending: counts.pending + counts.draft,
    items,
    conflicts,
    draftMeta: drafts.meta
      ? { reviewId: drafts.meta.reviewId || '', at: drafts.meta.at || '', model: drafts.meta.model || null }
      : null,
    summary:
      `${target.name}：共 ${items.length} 条｜已处理 ${counts.noted + counts.norevision + counts.needfix} 条` +
      `（意见 ${counts.noted}、无需修改 ${counts.norevision}）` +
      (counts.draft ? `｜待处理草稿 ${counts.draft}` : '') +
      (counts.pending ? `｜待审 ${counts.pending}` : '') +
      (conflicts.length ? `｜⚠ ${conflicts.length} 条结论打架` : ''),
  }
}

/**
 * 丢弃草稿 → 写「无需修改」判定，并把它从暂存里去掉。
 *
 * 为什么合成一个动作：界面上的「丢弃（无需修改）」是**一次**判断，
 * 分两步做会出现「判定写了、草稿还在」或反之的中间态（文档第七章的重复判断风险）。
 */
export function discardDraftAsNoRevision({ case: caseDirRaw, file, clause, reason, by } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const no = String(clause || '').trim()
  if (!no) throw new Error('缺条款号：不知道丢弃哪一条草稿')
  const why = String(reason || '').trim()
  if (why.length < 4) {
    throw new Error('丢弃要写一句理由（≥4 字）：说明为什么这条不用改，否则无法区分「看过」和「跳过」')
  }
  return { needRuling: true, dir, clause: no, reason: why, by: by || '' }
}

export const _internals = { norm, revisedClauses, draftClauses }

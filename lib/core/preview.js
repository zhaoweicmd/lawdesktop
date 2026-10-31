// 修订对照预览：在面板里就能看出"这一条改成什么样"，不必先生成 Word。
//
// 与 redline.js 的分工：
//   - 这里只算「条款原文 → 建议条文」的字符级差异，供界面显示；
//   - 真正的 docx 修订痕迹仍由 redline.reviseContract 生成（它管段落级插入与 Word 标记）。
// 所以本文件不做任何文件写入，纯计算。

import path from 'node:path'

import { casePaths, readJson, readJsonl } from './store.js'
import { loadClauses, loadNotes } from './clause.js'
import { splitDiff } from './redline.js'

/** 一条意见的修订预览 */
function previewOne(note, clause) {
  const before = String((clause && clause.text) || '')
  const fix = String(note.fix || '').trim()
  const diff = splitDiff(before, fix)
  return {
    noteId: note.id,
    clause: note.clause,
    clauseHeading: (clause && clause.heading) || note.clauseHeading || '',
    level: note.level,
    issue: note.issue,
    quote: note.quote || '',
    before,
    fix,
    diff,
    changed: !diff.same,
    removedChars: diff.oldMid.length,
    addedChars: diff.newMid.length,
  }
}

/**
 * 生成修订预览。
 * @param {{ case: string, file?: string, noteIds?: string[] }} opts
 */
export function previewRevision({ case: caseDirRaw, file, noteIds } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  if (!caseDirRaw) throw new Error('case 不能为空：请给出案件工作目录绝对路径')
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}`)

  const files = loadClauses(dir)
  if (!files.length) throw new Error('还没有条款索引：先 lc_clause_index')
  const want = String(file || '').trim()
  const target = want
    ? files.find((f) => f.name === want || f.file === want)
    : files[files.length - 1]
  if (!target) throw new Error(`条款索引里没有这份合同：${want}`)

  let notes = loadNotes(cp).filter((r) => r.file === target.name)
  if (Array.isArray(noteIds) && noteIds.length) {
    const set = new Set(noteIds.map((x) => String(x).toUpperCase()))
    notes = notes.filter((r) => set.has(String(r.id).toUpperCase()))
  }
  if (!notes.length) {
    throw new Error(`《${target.name}》还没有可预览的意见：先 lc_note_add 登记，或去掉 noteIds 过滤`)
  }

  const clauseMap = new Map((target.clauses || []).map((x) => [String(x.no), x]))
  const items = []
  const orphans = []
  const byClause = new Map()
  for (const n of notes) {
    const clause = clauseMap.get(String(n.clause))
    if (!clause) {
      orphans.push({ noteId: n.id, clause: n.clause, reason: '当前索引里找不到这一条（条款编号可能变了）' })
      continue
    }
    const item = previewOne(n, clause)
    items.push(item)
    if (!byClause.has(String(n.clause))) byClause.set(String(n.clause), [])
    byClause.get(String(n.clause)).push(item)
  }

  // 整份合并预览：按条款原顺序走，审过的条款换成建议条文（同一条多意见按登记顺序拼接，
  // 与 redline 的 grouped.lines 行为保持一致），没审的原样保留。
  const merged = []
  for (const cl of target.clauses || []) {
    const hits = byClause.get(String(cl.no)) || []
    if (!hits.length) {
      merged.push({ no: cl.no, text: cl.text, changed: false, noteIds: [] })
      continue
    }
    const newText = hits.map((h) => h.fix).join('\n')
    merged.push({ no: cl.no, text: newText, original: cl.text, changed: true, noteIds: hits.map((h) => h.noteId) })
  }

  const changedClauses = merged.filter((m) => m.changed).map((m) => m.no)
  const totalRemoved = items.reduce((n, x) => n + x.removedChars, 0)
  const totalAdded = items.reduce((n, x) => n + x.addedChars, 0)

  return {
    ok: true,
    file: target.name,
    source: target.file,
    // 面板预览是「字符级近似」：最终以 Word 修订痕迹为准（那里按段落插入）
    note: '预览按条款原文与建议条文做字符级对照；最终修订以 contract.revise 生成的 docx 为准。',
    count: items.length,
    clauseTotal: (target.clauses || []).length,
    changedClauses,
    orphans,
    items,
    merged,
    stats: { removedChars: totalRemoved, addedChars: totalAdded },
    summary:
      `《${target.name}》修订预览：${items.length} 条意见涉及 ${changedClauses.length} 条条款` +
      `（删 ${totalRemoved} 字 / 增 ${totalAdded} 字）` +
      (orphans.length ? `｜${orphans.length} 条意见的条款不在索引里` : ''),
  }
}

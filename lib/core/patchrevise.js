// 片段级修订的端到端：校验补丁 → 写进修订版 docx → 记录可接受的补丁。
//
// 三层保证，缺一不可：
//   1) patch.js 先判「能不能改」（唯一、不重叠、整批）
//   2) 原合同**只读**：只读字节、只写新文件
//   3) 修订版里只出现**已接受**的修改；拒绝的一律不出现在成品里
//
// 本文件负责落盘，所以它既写 out/ 也写 .lawcase/patch-review.json（逐条接受/拒绝的记录）。

import fs from 'node:fs'
import path from 'node:path'

import { casePaths, readJson, writeJsonAtomic, nowIso, log } from './store.js'
import { loadClauses, resolveContractRef } from './clause.js'
import { validatePatches, applyPatchesToText } from './patch.js'

function err(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function pickContract(dir, file) {
  const files = loadClauses(dir)
  if (!files.length) throw err('contract/none', '还没有索引合同：先在「条款」页把合同切成条款。')
  const target = file ? files.find((x) => x.name === file || x.file === file) : files[files.length - 1]
  if (!target) throw err('contract/missing', `条款索引里没有这份文件：${file}`)
  return target
}

/** 补丁记录文件：逐条接受/拒绝都要留痕，交付包要用 */
export function patchRecordPath(dir) {
  return path.join(casePaths(dir).state, 'patch-review.json')
}

/**
 * 只做校验 + 对照预览，**不写任何文件**（界面在生成 docx 前先看改了什么）。
 */
export function previewPatches({ case: caseDirRaw, file, patches } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  if (!readJson(casePaths(dir).caseJson, null)) throw err('case/not-a-case', `不是 LawCase 案件：${dir}`)
  const target = pickContract(dir, file)
  const v = validatePatches({ clauses: target.clauses, patches })
  if (!v.ok) {
    return { ok: false, code: v.code, message: v.message, rejected: v.rejected, file: target.name }
  }
  const applied = applyPatchesToText({ clauses: target.clauses, patches })
  return {
    ok: true,
    file: target.name,
    accepted: v.accepted.map((a) => ({ clause: a.clause, original: a.original, replacement: a.replacement, reason: a.reason })),
    additions: v.additions,
    diff: applied.diff,
    texts: applied.texts,
    summary: `${target.name}：${v.summary}`,
  }
}

/**
 * 应用片段级修订，生成修订版 docx。
 *
 * @param {object} p
 * @param {string} p.case
 * @param {string} [p.file]
 * @param {Array}  p.patches  [{clause, original, replacement, reason}]
 * @param {boolean} [p.acceptAll] 默认 true（界面勾选后传上来的就是已接受的集合）
 */
export async function applyPatches({ case: caseDirRaw, file, patches, acceptAll = true } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  if (!readJson(casePaths(dir).caseJson, null)) throw err('case/not-a-case', `不是 LawCase 案件：${dir}`)
  const target = pickContract(dir, file)

  const v = validatePatches({ clauses: target.clauses, patches })
  if (!v.ok) {
    // 拒绝也要留痕：否则说不清「为什么这次没生成修订版」
    try {
      writeJsonAtomic(patchRecordPath(dir), {
        file: target.name,
        at: nowIso(),
        status: 'rejected',
        code: v.code,
        message: v.message,
        rejected: v.rejected,
      })
    } catch (e) {}
    log(dir, 'patch-rejected', { code: v.code })
    throw err(v.code, v.message)
  }

  // 原合同只读：解析出**真实路径**后再确认存在，且绝不写它
  const srcAbs = target.file || resolveContractRef(dir, target.name)
  if (!fs.existsSync(srcAbs)) throw err('contract/missing-file', `合同原件不存在：${srcAbs}`)
  const before = fs.readFileSync(srcAbs)

  // 转成 redline 需要的 edits 形状：**传该条款改完后的全文**。
  //
  // 为什么传全文而不是片段：redline 内部用 splitDiff(原文, 新文) 做词级差异，
  // 只划真正变化的那几个字。之前试过只传片段，结果 redline 把片段当成「整条新条文」
  // 追加在原文后面，导出稿里同时出现新旧两版（还多了一个条号）——直接是废稿。
  const applied = applyPatchesToText({ clauses: target.clauses, patches })
  const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, '')
  const edits = []
  for (const c of target.clauses) {
    const newText = applied.texts[norm(c.no)] != null ? applied.texts[norm(c.no)] : applied.texts[c.no]
    // 片段级修订的语义就是"就地改正文"（用户已经逐句接受过），
    // 所以这里显式要 redline，不吃默认的 comment。
    if (newText != null) edits.push({ clauseNo: c.no, newText, apply: 'redline' })
  }
  if (!edits.length) throw err('patch/no-edits', '校验通过但没有任何可写入的修订：请检查补丁的 clause 是否与条款索引一致。')

  const { reviseContract } = await import('./redline.js')
  const out = reviseContract({ case: dir, file: target.name, edits, fragments: v.accepted })

  // 原件必须一字节未动
  const after = fs.readFileSync(srcAbs)
  if (!before.equals(after)) {
    throw err('contract/mutated', `检测到原合同被改动（${srcAbs}）：这是严重问题，请立即从备份恢复。`)
  }

  const record = {
    file: target.name,
    at: nowIso(),
    status: 'applied',
    acceptAll: Boolean(acceptAll),
    accepted: v.accepted.map((a) => ({
      clause: a.clause,
      original: a.original,
      replacement: a.replacement,
      reason: a.reason,
      issueId: a.issueId,
    })),
    additions: v.additions,
    rejected: [],
    outFile: out && out.outFile ? out.outFile : '',
    fragmentMode: true,
  }
  writeJsonAtomic(patchRecordPath(dir), record)
  log(dir, 'patch-applied', { count: v.accepted.length, additions: v.additions.length })

  return {
    ok: true,
    ...out,
    fragments: record.accepted,
    additions: record.additions,
    summary: `已生成片段级修订版（${v.accepted.length} 处替换${v.additions.length ? ` + ${v.additions.length} 处新增` : ''}）`,
  }
}

/** 读回补丁记录（界面显示"上次接受了哪几处"） */
export function loadPatchRecord({ case: caseDirRaw } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const d = readJson(patchRecordPath(dir), null)
  if (!d) return { ok: true, status: 'none', count: 0, summary: '还没有片段级修订记录' }
  return {
    ok: true,
    status: d.status,
    at: d.at,
    file: d.file,
    count: Array.isArray(d.accepted) ? d.accepted.length : 0,
    accepted: d.accepted || [],
    additions: d.additions || [],
    rejected: d.rejected || [],
    outFile: d.outFile || '',
    summary:
      d.status === 'applied'
        ? `${d.file || ''}：接受 ${(d.accepted || []).length} 处片段修订`
        : `上次修订未应用：${d.message || ''}`,
  }
}

export const _internals = { pickContract }

// 片段级修订：把「整条重写」细化成「只替换那一段话」。
//
// 文档 4.6 定的规则，逐条落在这里：
//   · original 必须在原文里**唯一**出现；出现 0 次或 ≥2 次都不得修改
//   · 同一批补丁之间不得**重叠**（重叠说明模型把同一处当成了两处）
//   · 新增条款最多一处，且集中追加（插入位置不明确时会写在条款末尾，但会标注）
//   · **任何一处不合格，整批拒绝**——绝不部分写回
//
// 为什么整批拒绝：部分应用会产生一份"改了一半"的合同，
// 而修订版是要拿去签的文件。改一半比不改危险得多。
//
// 本文件纯函数：只算补丁落在哪、能不能落，不碰 docx。

/** original 太短就没法唯一定位（「甲方」会出现在几十处） */
export const MIN_ORIGINAL_CHARS = 4

/** 一批最多几个补丁（防止模型把整篇切成碎片） */
export const MAX_PATCHES = 200

function err(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

/** 统计 needle 在 hay 里出现的次数（不重叠计数，避免 "aaa" 里 "aa" 算 2 次导致误判） */
export function countOccurrences(hay, needle) {
  const h = String(hay == null ? '' : hay)
  const n = String(needle == null ? '' : needle)
  if (!n) return 0
  let count = 0
  let from = 0
  for (;;) {
    const i = h.indexOf(n, from)
    if (i < 0) break
    count += 1
    from = i + n.length
    if (count > 1) return count // 多于 1 次就已经不唯一，没必要数完
  }
  return count
}

/**
 * 校验一批补丁能否应用。
 *
 * @param {object} p
 * @param {Array} p.clauses  [{no, text}] 条款索引
 * @param {Array} p.patches  [{clause, original, replacement, reason, issueId}]
 * @returns {{ok:boolean, code?:string, message?:string, accepted:Array, rejected:Array, additions:Array}}
 *   ok=false 时**一个都不能用**（整批拒绝）
 */
export function validatePatches({ clauses, patches } = {}) {
  const list = Array.isArray(patches) ? patches : []
  if (!list.length) return { ok: false, code: 'patch/empty', message: '没有任何片段级修订，无法生成修订版。', accepted: [], rejected: [], additions: [] }
  if (list.length > MAX_PATCHES) {
    return { ok: false, code: 'patch/too-many', message: `一次最多 ${MAX_PATCHES} 处修订，收到 ${list.length} 处。`, accepted: [], rejected: [], additions: [] }
  }

  const byNo = new Map()
  for (const c of Array.isArray(clauses) ? clauses : []) {
    const k = String(c && c.no == null ? '' : c.no).replace(/\s+/g, '')
    if (k) byNo.set(k, c)
  }

  const rejected = []
  const accepted = []
  const additions = []

  for (let i = 0; i < list.length; i += 1) {
    const p = list[i] || {}
    const clauseNo = String(p.clause == null ? '' : p.clause).replace(/\s+/g, '')
    const original = String(p.original == null ? '' : p.original)
    const replacement = String(p.replacement == null ? '' : p.replacement)

    if (!clauseNo) {
      rejected.push({ index: i, code: 'patch/no-clause', message: '第 ' + (i + 1) + ' 处缺 clause（条款号）' })
      continue
    }
    const clause = byNo.get(clauseNo)
    if (!clause) {
      rejected.push({ index: i, code: 'patch/clause-missing', message: `第 ${i + 1} 处：合同里没有「${clauseNo}」这一条` })
      continue
    }

    // ---- 新增段落：original 为空 ----
    if (!original.trim()) {
      if (!replacement.trim()) {
        rejected.push({ index: i, code: 'patch/empty', message: `第 ${i + 1} 处：original 与 replacement 都是空的` })
        continue
      }
      additions.push({
        index: i,
        clause: clause.no,
        replacement,
        reason: String(p.reason || '').slice(0, 400),
        // 插入点的位置由文件写入阶段决定；这里只声明"要加一段"
        mode: 'append-to-clause',
      })
      continue
    }

    if (original.trim().length < MIN_ORIGINAL_CHARS) {
      rejected.push({
        index: i,
        code: 'patch/original-too-short',
        message: `第 ${i + 1} 处：original 不足 ${MIN_ORIGINAL_CHARS} 字，无法唯一定位（「${original}」可能出现在很多地方）`,
      })
      continue
    }
    if (!replacement.trim()) {
      rejected.push({ index: i, code: 'patch/replacement-empty', message: `第 ${i + 1} 处：replacement 为空（要删除请写明「删除」用途的替换文案）` })
      continue
    }

    // ---- 唯一定位：必须在该条款里出现且仅出现一次 ----
    const body = String(clause.text || '')
    const n = countOccurrences(body, original)
    if (n === 0) {
      // 说清是不是抄到别的条款去了 —— 这是模型最常见的错法
      const elsewhere = (Array.isArray(clauses) ? clauses : []).filter(
        (c) => c && c.no !== clause.no && countOccurrences(String(c.text || ''), original) > 0
      )
      rejected.push({
        index: i,
        code: 'patch/original-not-found',
        message:
          `第 ${i + 1} 处：original 在「${clause.no}」原文里找不到` +
          (elsewhere.length ? `，但在「${elsewhere.map((c) => c.no).join('、')}」里出现了（条款错配）` : '（可能被模型改写过）'),
      })
      continue
    }
    if (n > 1) {
      rejected.push({
        index: i,
        code: 'patch/original-ambiguous',
        message: `第 ${i + 1} 处：original 在「${clause.no}」里出现不止一次，无法唯一定位，请写长一点`,
      })
      continue
    }

    const at = body.indexOf(original)
    accepted.push({
      index: i,
      clause: clause.no,
      original,
      replacement,
      reason: String(p.reason || '').slice(0, 400),
      issueId: p.issueId == null ? '' : String(p.issueId),
      start: at,
      end: at + original.length,
      mode: 'replace-fragment',
    })
  }

  // ---- 重叠检查：同一条款内区间相交即整批拒绝 ----
  const overlaps = []
  const groups = new Map()
  for (const a of accepted) {
    if (!groups.has(a.clause)) groups.set(a.clause, [])
    groups.get(a.clause).push(a)
  }
  for (const [clauseNo, arr] of groups) {
    arr.sort((x, y) => x.start - y.start)
    for (let i = 1; i < arr.length; i += 1) {
      const prev = arr[i - 1]
      const cur = arr[i]
      if (cur.start < prev.end) {
        overlaps.push(
          `「${clauseNo}」第 ${prev.index + 1} 处与第 ${cur.index + 1} 处的原文区间重叠（${prev.start}–${prev.end} 与 ${cur.start}–${cur.end}），无法判断先后`
        )
      }
    }
  }
  if (overlaps.length) {
    return {
      ok: false,
      code: 'patch/overlap',
      message: '补丁区间重叠，整批拒绝应用：' + overlaps.join('；'),
      accepted: [],
      rejected,
      additions: [],
    }
  }

  if (additions.length > 1) {
    return {
      ok: false,
      code: 'patch/too-many-additions',
      message: `新增条款最多允许 1 处，收到 ${additions.length} 处。插入位置不明确时，多处新增无法判断先后。`,
      accepted: [],
      rejected,
      additions: [],
    }
  }

  // 只要有任一被拒，整批不应用（文档 4.6：任何失败都不能部分写回）
  if (rejected.length) {
    return {
      ok: false,
      code: 'patch/partial-rejected',
      message: `${rejected.length} 处修订不合格，整批未应用（避免出现「改了一半」的合同）：` + rejected.map((r) => r.message).join('；'),
      accepted: [],
      rejected,
      additions: [],
    }
  }

  return {
    ok: true,
    accepted,
    rejected,
    additions,
    summary: `可应用 ${accepted.length} 处片段替换` + (additions.length ? `，另有 ${additions.length} 处新增段落` : ''),
  }
}

/**
 * 把补丁应用到条款文本上（只用于**对照预览**，真正的修订走 docx 的 doRevise）。
 *
 * 注意：这是纯文本层面的模拟，用来给界面「原文 / 建议文」对照。
 * 输出文件永远由 redline 基于原 docx 生成，不会用这段文本覆盖原件。
 */
export function applyPatchesToText({ clauses, patches } = {}) {
  const v = validatePatches({ clauses, patches })
  if (!v.ok) return { ok: false, code: v.code, message: v.message, texts: null, diff: [] }
  const byNo = new Map()
  for (const c of clauses || []) byNo.set(String(c.no).replace(/\s+/g, ''), c)

  // 同一条款多处替换：从后往前改，避免前面的修改挪动后面的偏移
  const perClause = new Map()
  for (const a of v.accepted) {
    if (!perClause.has(a.clause)) perClause.set(a.clause, [])
    perClause.get(a.clause).push(a)
  }

  const texts = {}
  const diff = []
  for (const [clauseNo, arr] of perClause) {
    const c = byNo.get(clauseNo)
    let body = String((c && c.text) || '')
    arr.sort((x, y) => y.start - x.start)
    for (const a of arr) {
      body = body.slice(0, a.start) + a.replacement + body.slice(a.end)
      diff.push({ clause: clauseNo, before: a.original, after: a.replacement, reason: a.reason })
    }
    texts[clauseNo] = body
  }
  for (const ad of v.additions) {
    const c = byNo.get(ad.clause)
    if (!c) continue
    const prev = texts[ad.clause] != null ? texts[ad.clause] : String(c.text || '')
    texts[ad.clause] = prev + '\n' + ad.replacement
    diff.push({ clause: ad.clause, before: '', after: ad.replacement, reason: ad.reason, addition: true })
  }
  return { ok: true, texts, diff, accepted: v.accepted, additions: v.additions, summary: v.summary }
}

export const _internals = { err }

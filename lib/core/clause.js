import path from 'node:path'
import fs from 'node:fs'
import { readDocx } from './docx.js'
import { readXlsx } from './xlsx.js'
import { casePaths, readJson, writeJsonAtomic, readJsonl, appendJsonl, nowIso, log } from './store.js'
import { normalizeReviewConfig, reviewBrief } from './contractcfg.js'
import { safeFileName } from './filename.js'

export const NOTE_LEVELS = ['重大风险', '建议修改', '提示']

/** 「内容空泛」的实证词表：这些词出现在审核意见里，等于没说。
 *  来源：问卷 C2 选的就是「内容空泛」，而真实律师批注里没有一条是这样写的。 */
export const VAGUE = [
  '进一步明确', '予以完善', '建议完善', '酌情', '视情况', '予以考虑',
  '需要关注', '应予关注', '加强', '优化', '适当调整', '注意核实',
]

const CN_NUM = '一二三四五六七八九十百零〇'
const ARTICLE_RE = new RegExp(`^\\s*第[${CN_NUM}\\d]+条`)

// 自动编号还原后的顶层序号：「1. 居间服务项目」「2、合作期限」「一、服务费用」。
// 只认单级序号（1. / 2、），**不认** 1.1 / 2.3 —— 那些是「款」，误当成条会把一本合同切碎。
const NUM_DOT_RE = /^\s*(\d{1,2})\s*[.．、]\s*(?!\d)\S/

function looksLikeArticle(text) {
  return ARTICLE_RE.test(text) || NUM_DOT_RE.test(text)
}

/** 条款编号：优先「第X条」，其次还原出来的顶层数字 */
function articleNoOf(text) {
  const cn = text.match(ARTICLE_RE)
  if (cn) return cn[0].replace(/\s+/g, '')
  const num = text.match(NUM_DOT_RE)
  if (num) return num[1]
  return text.slice(0, 20)
}

/** 从 docx 段落里切条款：一条 = 该段起，到下一条之前。
 *  两种形状：字面的「第X条」，或 readDocx 还原出来的顶层自动编号（1. / 一、）。 */
export function splitClauses(paras) {
  // 一份合同里常有多组编号：正文条款一组、附件清单另一组（都从 1 开始）。
  // 只认「出现次数最多的那一组」当条款，否则附件里的列表会被误读成第 14、15 条。
  const byList = new Map()
  for (const p of paras) {
    const t = String(p.text ?? p).trim()
    if (!t) continue
    const isTop = p.ilvl == null ? looksLikeArticle(t) : p.ilvl === 0
    if (!isTop || !looksLikeArticle(t)) continue
    const key = p.numListId == null ? '_literal' : String(p.numListId)
    byList.set(key, (byList.get(key) || 0) + 1)
  }
  let mainList = null
  let best = 0
  for (const [k, n] of byList) {
    if (n > best) {
      best = n
      mainList = k
    }
  }

  const clauses = []
  let cur = null
  for (const p of paras) {
    const text = String(p.text ?? p).trim()
    if (!text) continue
    // readDocx 给了 ilvl 就信它：只有顶层（ilvl 0）才是「条」，款（ilvl 1+）归入上一条
    const isTop = p.ilvl == null ? looksLikeArticle(text) : p.ilvl === 0
    const key = p.numListId == null ? '_literal' : String(p.numListId)
    const sameList = p.numListId == null || mainList == null || mainList === '_literal' || key === mainList
    if (isTop && looksLikeArticle(text) && sameList) {
      if (cur) clauses.push(cur)
      cur = { no: articleNoOf(text), title: text.slice(0, 120), from: p.n ?? null, body: [text] }
    } else if (cur) {
      cur.body.push(text)
    }
  }
  if (cur) clauses.push(cur)

  // ⚠ 去重：一份合同里可能同时存在两套编号 ——
  //   前言用「1、2、3、」（中文顿号或阿拉伯数字），正文用「第一条、第二条」。
  //   真机上（2026-11-01）这两套都被切成了条款，结果是 `1` 与 `第一条` 指向同一位置：
  //   界面上同一条款渲染两次、意见的键对不上、保存时误报「已登记过相同问题」。
  //
  //   判据：如果**存在「第X条」体系**，就只保留它；纯数字编号一律视为前言的列举。
  //   只有在完全没有「第X条」时（自动编号合同）才退回用数字。
  const hasCnArticles = clauses.some((c) => /第[零一二三四五六七八九十百]+条/.test(String(c.no)))
  let kept = hasCnArticles ? clauses.filter((c) => /第[零一二三四五六七八九十百]+条/.test(String(c.no))) : clauses

  // 再防一层：同一份文档里条号重复（典型是正文 + 附件各有一套「第一条…」）。
  // 重复编号会让「意见 → 条款」的对应关系含糊不清（改这条可能落到附件那条），
  // 所以只保留**第一次出现**的那条，并在标题里标明后面重复的被忽略了。
  const seenNo = new Set()
  kept = kept.filter((c) => {
    const key = String(c.no).replace(/\s+/g, '')
    if (seenNo.has(key)) return false
    seenNo.add(key)
    return true
  })

  return kept.map((c) => ({
    no: c.no,
    heading: c.title,
    from: c.from,
    text: c.body.join('\n'),
    chars: c.body.join('\n').length,
    lines: c.body.length,
  }))
}

/**
 * 把「用户/AI 给的一个引用」解析成磁盘上的绝对路径。
 *
 * 支持四种写法，按顺序试：
 *   1) 材料编号 M3        → 查材料台账里的 abs
 *   2) 绝对路径            → 直接用
 *   3) 相对案件目录的路径  → path.resolve(dir, ref)
 *   4) 材料台账里的文件名  → 按 basename 唯一匹配
 *
 * 为什么要这么麻烦：以前只有 `path.resolve(ref)`，相对路径按**进程 cwd** 解析，
 * 而 DSH Desktop 宿主的 cwd 是 launch-root，用户敲个文件名就必然报
 * 「合同文件不存在：/…/launch-root/xxx.docx」。看着像能用，实际是陷阱。
 */
export function resolveContractRef(dir, ref) {
  const raw = String(ref || '').trim()
  if (!raw) throw new Error('没有给要索引的合同：传材料编号（如 M1）或文件路径')

  const cp = casePaths(dir)
  const mat = readJson(cp.materials, null)
  const files = (mat && mat.files) || []

  // 1) 材料编号
  if (/^M\d+$/i.test(raw)) {
    const hit = files.find((f) => String(f.mid).toUpperCase() === raw.toUpperCase())
    if (!hit) throw new Error(`材料台账里没有 ${raw.toUpperCase()}（现有 ${files.length} 个文件）`)
    return hit.abs
  }

  // 2) 绝对路径
  if (path.isAbsolute(raw)) {
    if (!fs.existsSync(raw)) throw new Error(`合同文件不存在：${raw}`)
    return raw
  }

  // 3) 相对案件目录
  const byCase = path.resolve(dir, raw)
  if (fs.existsSync(byCase)) return byCase

  // 4) 材料台账里的文件名（唯一匹配才算数，重名就要求说清是哪一份）
  const same = files.filter((f) => f.name === raw || f.rel === raw)
  if (same.length === 1) return same[0].abs
  if (same.length > 1) {
    throw new Error(`有 ${same.length} 份同名文件，请用材料编号指定：${same.map((f) => `${f.mid}（${f.rel}）`).join('、')}`)
  }

  throw new Error(
    `找不到「${raw}」。已试：材料编号、绝对路径、案件目录下、材料台账文件名。` +
      (files.length ? `台账里的文件：${files.map((f) => `${f.mid}=${f.name}`).join('、')}` : '材料台账还是空的（先扫材料）')
  )
}

/**
 * 列出「可以索引为合同」的候选：材料台账里的 docx，标出是否已索引。
 * 条款页据此直接给按钮——用户不该为了一个确定性操作去敲路径。
 */
export function contractCandidates({ case: caseDirRaw }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const mat = readJson(cp.materials, null)
  const store = readJson(cp.clauses, { files: [] })
  const indexed = new Map((store.files || []).map((x) => [x.file, x]))
  // 明确「决定不索引」的：不再反复出现在待办里。
  // 场景（2026-11-01 用户实测）：卷宗里常混着劳动合同、居间协议、保密承诺这类
  // 根本没有「第X条」的附件，或者这份合同这次根本不审。只要它们一天不消失，
  // 「索引条款」这一步就永远完成不了，人就卡在那儿动不了。
  const skip = new Map((store.skipped || []).map((x) => [x.abs, x]))
  const files = (mat && mat.files) || []
  return files
    .filter((f) => String(f.ext).toLowerCase() === '.docx')
    .map((f) => {
      const got = indexed.get(f.abs)
      const sk = skip.get(f.abs)
      return {
        mid: f.mid,
        name: f.name,
        rel: f.rel,
        abs: f.abs,
        size: f.size,
        exists: fs.existsSync(f.abs),
        indexed: Boolean(got),
        clauseCount: got ? got.clauses.length : 0,
        skipped: Boolean(sk) && !got,
        skipReason: sk ? sk.reason || '' : '',
      }
    })
}

/** 读「明确不索引」的表（clauses.json 的 skipped 数组） */
export function loadSkipped(caseDirRaw) {
  return readJson(casePaths(path.resolve(caseDirRaw)).clauses, { files: [] }).skipped || []
}

/**
 * 标记「这份不索引」——把一个永远做不完的步骤收口掉。
 *
 * 设计克制：
 *   - 必须写理由（≥2 字）：不写理由的"跳过"过两个月没人知道为什么；
 *   - 已经索引过的不能直接跳（那会让条款凭空消失），先取消索引再说；
 *   - 可以取消跳过（unskip），随时反悔。
 */
export function skipContract({ case: caseDirRaw, file, reason, unskip = false }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  if (!readJson(cp.caseJson, null)) throw new Error(`不是 LawCase 案件：${dir}`)
  const f = resolveContractRef(dir, file)
  const store = readJson(cp.clauses, { files: [] })
  store.files = store.files || []
  store.skipped = store.skipped || []

  const indexedEntry = store.files.find((x) => x.file === f)
  const cur = store.skipped.find((x) => x.abs === f)

  if (unskip) {
    if (!cur) throw new Error('这份合同本来就没被跳过')
    store.skipped = store.skipped.filter((x) => x.abs !== f)
    writeJsonAtomic(cp.clauses, store)
    log(dir, { op: 'clause-unskip', file: path.basename(f) })
    return { ok: true, file: f, skipped: false, summary: `已恢复《${path.basename(f)}》为「未索引」` }
  }

  if (indexedEntry) {
    throw new Error(
      `《${path.basename(f)}》已经索引了 ${indexedEntry.clauses.length} 条条款，不能直接跳过。` +
      `如果确实不审这份合同，请先取消索引（lc_clause_unindex）再跳过，否则已登记的意见会指向不存在的条款。`
    )
  }

  // 理由改为**选填**（用户 2026-11-01：未索引的一律默认为不审，不必再确认）。
  // 这个标记只用来把「我明确看过、决定不审」和「还没轮到」区分开，
  // 不写理由也成立；写了就记下来（给接手的人看）。
  const why = String(reason || '').trim()

  if (!cur) store.skipped.push({ abs: f, name: path.basename(f), reason: why, at: nowIso() })
  else { cur.reason = why; cur.at = nowIso() }
  writeJsonAtomic(cp.clauses, store)
  log(dir, { op: 'clause-skip', file: path.basename(f), reason: why })
  return {
    ok: true,
    file: f,
    skipped: true,
    reason: why,
    summary: `已标记《${path.basename(f)}》不索引${why ? `（${why}）` : ''}｜未索引的合同本来就不参与审核`,
  }
}

/** 取消一份合同的条款索引（与「跳过」配套，让两种状态互斥） */
export function unindexClauses({ case: caseDirRaw, file }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  if (!readJson(cp.caseJson, null)) throw new Error(`不是 LawCase 案件：${dir}`)
  const f = resolveContractRef(dir, file)
  const store = readJson(cp.clauses, { files: [] })
  const before = (store.files || []).length
  store.files = (store.files || []).filter((x) => x.file !== f)
  if (store.files.length === before) throw new Error(`条款索引里没有《${path.basename(f)}》`)
  writeJsonAtomic(cp.clauses, store)
  log(dir, { op: 'clause-unindex', file: path.basename(f) })
  return { ok: true, file: f, summary: `已取消《${path.basename(f)}》的条款索引（${before - store.files.length} 份）` }
}

export function indexClauses({ case: caseDirRaw, file }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  if (!readJson(cp.caseJson, null)) throw new Error(`不是 LawCase 案件：${dir}`)
  const f = resolveContractRef(dir, file)
  const ext = path.extname(f).toLowerCase()
  if (ext !== '.docx') throw new Error(`条款索引目前只支持 .docx（收到 ${ext || '无扩展名'}）`)
  const buf = fs.readFileSync(f)
  const paras = readDocx(buf)
  const clauses = splitClauses(paras)
  if (!clauses.length) {
    throw new Error(
      `没识别出任何「第X条」：这份文档可能没有条款编号，或是扫描件。共读到 ${paras.length} 段。`
    )
  }
  const store = readJson(cp.clauses, { files: [] })
  const key = path.basename(f)
  const entry = {
    file: f, name: key, parsedAt: nowIso(), paragraphs: paras.length,
    clauses: clauses.map((c) => ({ ...c })),
  }
  store.files = (store.files || []).filter((x) => x.file !== f)
  store.files.push(entry)
  writeJsonAtomic(cp.clauses, store)
  log(dir, 'clause-index', { file: key, count: clauses.length })
  return {
    ok: true, file: f, count: clauses.length,
    clauses: clauses.map((c) => ({ no: c.no, heading: c.heading.slice(0, 60), chars: c.chars, from: c.from })),
    summary: `已索引《${key}》${clauses.length} 条（${paras.length} 段）｜${clauses.map((c) => c.no).join('、')}`,
  }
}

export function loadClauses(dir) {
  const cp = casePaths(dir)
  const s = readJson(cp.clauses, { files: [] })
  return s.files || []
}

export function findClause(dir, file, no) {
  const files = loadClauses(dir)
  const target = file ? files.find((x) => x.name === file || x.file === file) : files[files.length - 1]
  if (!target) throw new Error('还没有索引任何合同：先 lc_clause_index')
  const norm = String(no || '').replace(/\s+/g, '')
  const hit = target.clauses.find((c) => c.no.replace(/\s+/g, '') === norm)
  if (!hit) throw new Error(`${target.name} 里没有「${no}」这一条（共 ${target.clauses.length} 条：${target.clauses.slice(0, 5).map((c) => c.no).join('、')}…）`)
  return { file: target, clause: hit }
}

/** 空白规范化后比较：引文常跨行/带缩进，逐字核对前先把空白压平 */
function normSpace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

/** 去掉全部空白再比：中文没有词间空格，「日\n前」与「日前」必须算同一句 */
function squeezeSpace(s) {
  return String(s || '').replace(/\s+/g, '')
}

/** 引文最短长度：太短的引文（"付款"两字）在任何合同里都能命中，核对了也没意义 */
export const QUOTE_MIN = 6

/** 登记一条条款级审核意见。
 *  硬要求：指到具体条款、说清问题、给出可直接替换的文本。三者缺一不收。
 *  给了引文（quote）就必须在该条款原文里逐字出现——意见要能从"我认为"变成"这句原文导致"。 */
export function addNote({ case: caseDirRaw, file, clause, level = '重大风险', issue, fix, basis, quote, updateId, allowDuplicate, apply }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const lv = String(level).trim()
  if (!NOTE_LEVELS.includes(lv)) throw new Error(`风险级别只能是：${NOTE_LEVELS.join(' / ')}`)
  const iss = String(issue || '').trim()
  const fx = String(fix || '').trim()
  // 字数下限已取消（用户 2026-11-01）：律师一句话能把问题说清就够了，
  // 拿 15 字卡人只会逼出凑字的废话。仍然拦的两件事是：
  //   ① 两者都空（登记一条空意见没有意义）；
  //   ② 空泛表述（「建议完善」这种，拦的是没有信息量，不是不够长）。
  if (!iss && !fx) throw new Error('问题与修改方案不能都为空：至少要写一处，否则这条意见没有意义')
  const vague = VAGUE.filter((v) => fx.includes(v) || iss.includes(v))
  if (vague.length) {
    throw new Error(
      `审核意见里出现空泛表述（${vague.join('、')}）：这类话不能作为交付意见，` +
        `要么写出具体替换条文，要么写清具体事实缺口。`
    )
  }
  if (/^(见上|同上|略|待定)/.test(fx)) throw new Error('修改方案不能写「见上/同上/待定」：每条意见都要能单独看懂')
  const { file: F, clause: C } = findClause(dir, file, clause)
  // 引文核对：不做「相似即通过」，必须逐字。
  // 只容忍空白差异：中文没有词间空格，跨行/缩进造成的空白不一致不是「改写」。
  const q = normSpace(quote)
  const hitQuote = Boolean(q) && (normSpace(C.text).includes(q) || squeezeSpace(C.text).includes(squeezeSpace(q)))
  if (q) {
    if (q.length < QUOTE_MIN) {
      throw new Error(`引文太短（${q.length} 字，至少 ${QUOTE_MIN} 字）：这样短的引文在任何合同里都能命中，等于没核对`)
    }
    if (!hitQuote) {
      throw new Error(
        `引文没有在「${C.no}」里逐字出现：${q.slice(0, 40)}…\n` +
          `这条引文必须从该条款原文里原样摘抄（标点/数字/用字都要一致），不能改写成同义句。\n` +
          `该条款开头：${normSpace(C.text).slice(0, 60)}…`
      )
    }
  }
  const rows = loadNotes(cp)
  // apply：这条意见落到 Word 里用哪种形式
  //   'comment'（默认）—— 正文一个字不动，只挂批注。对外发意见稿用这个：
  //                      律师给客户的是建议，改不改由客户定，替人改正文越界。
  //   'redline'        —— 正文画红色删除线 + 新文下划线，用于"我们已改好的稿子"。
  // 早期版本一律 redline，用户实测后发现正文被连成一句、审阅人容易误读（2026-11-01）。
  const applyMode = normalizeApply(apply, {
    hadComment: false,
  })
  // 同一条款允许多个不同问题（一条条款常同时有付款、验收、解除三处问题），
  // 只拦「完全重复登记」——那才是误操作。
  const dup = rows.find(
    (r) => r.file === F.name && r.clause === C.no && String(r.issue).slice(0, 30) === iss.slice(0, 30)
  )
  // updateId：同一编号**原地更新**（追加一行覆盖旧行，不删原始记录，可审计）。
  // 界面在「实际修改意见」里点保存时走这条：那是"改这一条"，不是"新登一条"。
  if (updateId) {
    const want = String(updateId).toUpperCase()
    const old = rows.find((r) => String(r.id || '').toUpperCase() === want)
    if (!old) {
      const e = new Error(`没有 ${want} 这条审核意见，无法更新`)
      e.code = 'note/not-found'
      throw e
    }
    const next = {
      id: old.id,
      file: old.file,
      clause: old.clause,
      clauseHeading: old.clauseHeading,
      level: lv,
      issue: iss,
      fix: fx,
      basis: basis ? String(basis).trim() : old.basis,
      quote: q || old.quote,
      apply: normalizeApply(apply, { prev: old.apply }),
      at: nowIso(),
      updatedAt: nowIso(),
    }
    appendJsonl(cp.notes, next)
    log(dir, { op: 'note-update', id: old.id, clause: old.clause })
    return { ok: true, note: next, updated: true, summary: `已更新 ${old.id}｜${old.clause}｜${lv}` }
  }

  if (dup && !allowDuplicate) {
    // 同一条款、同一个问题再保存一次，语义上就是「改这一条」——
    // 直接原地更新，不要报错。
    //
    // 为什么改（2026-11-01 用户实测）：界面在草稿阶段还没有 note id，
    // 传不出 updateId，于是每次保存都撞去重，弹出一句
    // 「请用『更新』」——而**根本没有那个按钮**。等于让用户去点一个不存在的东西。
    // 现在：撞上了就更新，并在摘要里说清"已更新 N6"。
    const next = {
      id: dup.id,
      file: dup.file,
      clause: dup.clause,
      clauseHeading: dup.clauseHeading,
      level: lv,
      issue: iss,
      fix: fx,
      basis: basis ? String(basis).trim() : dup.basis,
      quote: q || dup.quote,
      apply: normalizeApply(apply, { prev: dup.apply }),
      at: nowIso(),
      updatedAt: nowIso(),
    }
    appendJsonl(cp.notes, next)
    log(dir, { op: 'note-update', id: dup.id, clause: dup.clause, via: 'auto-dedupe' })
    return {
      ok: true,
      note: next,
      updated: true,
      summary: `已更新 ${dup.id}｜${dup.clause}｜${lv}（同一条款同一问题重复登记时自动更新，不再新建一条）`,
    }
  }

  // 编号取「已存在的最大 N + 1」。
  // 不能用 rows.length + 1：loadNotes 会把同 id 的行折叠成一条，
  // 作废行与折叠都会让行数小于真实编号，直接导致撞号
  // （真机踩到：N3 被重复用了 6 次，后来的意见全挂在同一个编号下）。
  // 关键：要读**含作废行**的全部记录来算最大编号。
  // rows 已经过滤掉 __deleted，若只看它，作废 N2 后新意见又会拿到 N2，
  // 而历史里那条作废的 N2 仍在文件里——同一个编号指两条不同意见，台账就乱了。
  const allRows = readJsonl(cp.notes).filter((r) => r && !r.__broken)
  const maxNo = allRows.reduce((mx, r) => {
    const m = String(r.id || '').match(/^N(\d+)$/i)
    return m ? Math.max(mx, Number(m[1])) : mx
  }, 0)
  const used = new Set(allRows.map((r) => String(r.id || '').toUpperCase()))
  let idNo = maxNo + 1
  while (used.has('N' + idNo)) idNo += 1
  const id = 'N' + idNo
  const row = {
    id, file: F.name, clause: C.no, clauseHeading: C.heading.slice(0, 80),
    level: lv, issue: iss, fix: fx, basis: basis ? String(basis).trim() : undefined,
    quote: q || undefined,
    // 'comment' = 正文不动，只挂批注（默认）；'redline' = 正文画红线改掉
    apply: applyMode,
    at: nowIso(),
  }
  appendJsonl(cp.notes, row)
  log(dir, 'note-add', { id, clause: C.no, level: lv, quoted: Boolean(q) })
  return {
    ok: true, note: row,
    summary:
      `已登记 ${id}｜${C.no}｜${lv}｜${applyMode === 'redline' ? '改正文' : '只批注'}｜问题：${iss.slice(0, 24)}…` +
      (q ? '（引文已逐字核对）' : '（未给引文）'),
  }
}

/**
 * 归一「意见落到 Word 的形式」。
 *   comment（默认）：正文一个字不动，只挂批注 —— 对外发意见稿的正确姿势。
 *   redline        ：正文画红色删除线 + 新文下划线 —— 用于"我们已改好的稿子"。
 * 默认给 comment，是因为替客户改正文属于越界；要改必须显式点名。
 */
export const APPLY_MODES = ['comment', 'redline']
export function normalizeApply(v, { prev } = {}) {
  const s0 = String(v == null ? '' : v).trim().toLowerCase()
  if (s0 === 'comment' || s0 === 'annotation' || s0 === 'note') return 'comment'
  if (s0 === 'redline' || s0 === 'revision' || s0 === 'track') return 'redline'
  if (prev) return normalizeApply(prev)
  return 'comment'
}

/**
 * 条款编号 → 数字：认「第二十三条」「第4条」「4」「4.」四种写法。
 *
 * 放在 clause.js 而不是 redline.js：reviseContract 需要它，
 * 而 redline.js 已经 import clause.js（loadNotes），反向引用会成环。
 */
export function clauseNoOf(text) {
  const s = String(text || '').trim()
  const arabic = s.match(/^第?\s*(\d{1,3})\s*条?$/) || s.match(/^(\d{1,3})[.．、]/)
  if (arabic) return Number(arabic[1])
  const m = s.match(/第([零一二三四五六七八九十百]+)条/)
  if (!m) return null
  const d = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  let total = 0
  let num = 0
  for (const ch of m[1]) {
    if (d[ch] !== undefined) num = d[ch]
    else if (ch === '十') { total += (num || 1) * 10; num = 0 }
    else if (ch === '百') { total += (num || 1) * 100; num = 0 }
  }
  return total + num
}

/**
 * 读意见台账：**按 id 折叠**后再过滤。
 *
 * notes.jsonl 是追加写：作废一条意见会追加 `{id, __deleted:true}`，原始那一行仍在文件里。
 * 只做「整行过滤」的话，原件会把作废标记抵消掉——删过的意见继续出现在列表、报告、
 * 修订版和验收里（踩过：N5 已 delete，验收仍报它含空泛词）。
 */
export function loadNotes(cp) {
  const byId = new Map()
  const order = []
  for (const r of readJsonl(cp.notes)) {
    if (r.__broken) continue
    const id = r.id == null ? '' : String(r.id)
    if (!id) continue
    const prev = byId.get(id)
    if (!prev) order.push(id)
    // 后写覆盖先写：只有 __deleted 的那行会盖住原件
    byId.set(id, prev ? { ...prev, ...r } : r)
  }
  return order.map((id) => byId.get(id)).filter((r) => !r.__deleted)
}

export function listNotes({ case: caseDirRaw }) {
  const dir = path.resolve(caseDirRaw)
  const rows = loadNotes(casePaths(dir))
  const byLevel = {}
  for (const r of rows) byLevel[r.level] = (byLevel[r.level] || 0) + 1
  return {
    ok: true, count: rows.length, byLevel, notes: rows,
    summary: rows.length
      ? `审核意见 ${rows.length} 条｜` + Object.entries(byLevel).map(([k, v]) => `${k} ${v}`).join('、')
      : '还没有审核意见',
  }
}

export function deleteNote({ case: caseDirRaw, id }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const rows = loadNotes(cp)
  const hit = rows.find((r) => r.id === String(id).toUpperCase())
  if (!hit) throw new Error(`没有 ${id} 这条审核意见`)
  appendJsonl(cp.notes, { id: hit.id, __deleted: true, at: nowIso() })
  log(dir, 'note-delete', { id: hit.id })
  return { ok: true, summary: `已删除 ${hit.id}（${hit.clause} 的意见作废，原记录保留可审计）` }
}

/** 生成审核报告（Markdown），写到 out/ 下 */
export function buildReport({ case: caseDirRaw }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}`)
  const files = loadClauses(dir)
  const notes = loadNotes(cp)
  if (!files.length) throw new Error('还没有索引合同：先 lc_clause_index')
  if (!notes.length) throw new Error('还没有审核意见：先 lc_note_add（报告不能出空表）')

  // ---- 发布前闸门：这些意见本身是坏的，不能印给客户 ----
  // 真机见过（2026-11-01）：某几条的「修改方案」等于「问题描述」，
  // 甚至把**审核指令**（"你是甲方的律师…"）当成了修改条文写进台账。
  // 报告是对外交付物，宁可拒绝出表并点名，也不能把这种东西印出去。
  const bad = notes
    .map((n) => {
      const issue = String(n.issue || '').trim()
      const fix = String(n.fix || '').trim()
      if (!fix) return { id: n.id, clause: n.clause, why: '没有修改方案' }
      if (fix === issue) return { id: n.id, clause: n.clause, why: '修改方案与问题描述完全相同（不是替代表述）' }
      if (/你是.{0,6}律师|审核此合同|作为律师|主要审核/.test(fix) && !/[。；]$/.test(fix.slice(0, 40))) {
        return { id: n.id, clause: n.clause, why: '修改方案里出现审核指令的原话（像是把提示词当成了条文）' }
      }
      return null
    })
    .filter(Boolean)
  if (bad.length) {
    const e = new Error(
      `有 ${bad.length} 条意见不能出报告：\n` +
        bad.map((b) => `  · ${b.id}（${b.clause}）：${b.why}`).join('\n') +
        '\n请到「意见」页把这几条改成可以直接替换的条文，再出报告。'
    )
    e.code = 'report/bad-notes'
    e.badNotes = bad
    throw e
  }

  const outDir = path.join(dir, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const name = safeFileName(`合同审核意见_${(c.caseId || '').slice(0, 15)}.md`, { fallback: '合同审核意见.md' })
  const outFile = path.join(outDir, name)

  const order = { 重大风险: 0, 建议修改: 1, 提示: 2 }
  const sorted = [...notes].sort((a, b) => (order[a.level] - order[b.level]) || String(a.clause).localeCompare(String(b.clause), 'zh'))
  const stat = { 重大风险: 0, 建议修改: 0, 提示: 0 }
  for (const n of notes) stat[n.level]++
  const quoted = notes.filter((n) => n.quote).length

  const lines = [
    `# 合同审核意见 · ${files[0].name}`,
    '',
    `- 案件：${c.title}（${c.caseId}）`,
    // 立场与类型必须写在首页：复核的人要先知道"这份意见是替谁审的"
    `- 审核口径：${reviewBrief(c.review)}`,
    `- 审核时间：${nowIso()}`,
    `- 意见总数：**${notes.length}**（重大风险 ${stat['重大风险']}｜建议修改 ${stat['建议修改']}｜提示 ${stat['提示']}）`,
    `- 条款总数：${files[0].clauses.length}`,
    `- 引文核对：${quoted}/${notes.length} 条意见带有逐字引文` + (quoted === notes.length ? '' : '（其余意见只指条款号，未引原句）'),
    '',
    '> 本表由 LawCase 生成，每条意见均指向具体条款并给出替换文本。法律结论由执业律师复核后定稿。',
    '',
    '## 意见汇总',
    '',
    '| 编号 | 条款 | 级别 | 问题 |',
    '|---|---|---|---|',
    ...sorted.map((n) => `| ${n.id} | ${n.clause} | ${n.level} | ${String(n.issue).replace(/\|/g, '/').slice(0, 50)} |`),
    '',
    '## 逐条意见',
    '',
  ]
  for (const n of sorted) {
    lines.push(`### ${n.id}｜${n.clause}｜${n.level}`, '')
    // 剥掉条款号只看标题：clauseHeading 形如 "4. 服务费用" 或 "第五条 服务费用"。
    // 直接 replace(n.clause,'') 会把 "4" 从 "4. 服务费用" 里抠掉，剩下 ". 服务费用"。
    const heading = String(n.clauseHeading || '').replace(/^\s*(第[零一二三四五六七八九十百\d]+条|\d{1,3}\s*[.．、])\s*/, '').trim()
    if (heading) lines.push(`**原文**：${heading}`, '')
    if (n.quote) lines.push(`**引文**：${n.quote}`, '')
    lines.push(`**问题**：${n.issue}`, '')
    if (n.basis) lines.push(`**依据**：${n.basis}`, '')
    lines.push(`**修改方案**`, '', '```', n.fix, '```', '')
  }
  lines.push('---', '', '本意见表不构成法律意见书，需经承办律师复核签署。', '')
  const md = lines.join('\n')
  fs.writeFileSync(outFile, md, 'utf8')
  log(dir, 'report', { file: outFile, notes: notes.length })
  return {
    ok: true, file: outFile, count: notes.length, stat,
    summary: `已生成审核意见 ${outFile}｜${notes.length} 条（重大风险 ${stat['重大风险']}、建议修改 ${stat['建议修改']}、提示 ${stat['提示']}）`,
  }
}

/**
 * 给「AI 预生成」用的条款清单：一次给出全部待审条款 + 每条可直接引用的原文句子。
 *
 * 为什么要有它：登记意见要求「引文必须逐字命中该条款」，而让人（或模型）凭记忆
 * 抄一句原文，命中的概率很低——被拒收之后只能去翻原文重新找。
 * 这里把每条条款切成句子候选，回填时直接选一句，命中率 100%。
 *
 * 只读：不写任何文件。
 */
export function reviewWorksheet({ case: caseDirRaw, file, maxSentences = 8 }) {
  const dir = path.resolve(caseDirRaw)
  const files = loadClauses(dir)
  if (!files.length) throw new Error('还没有索引合同：先 lc_clause_index')
  const target = file ? files.find((x) => x.name === file || x.file === file) : files[files.length - 1]
  if (!target) throw new Error(`条款索引里没有这份文件：${file}`)

  // 已有意见：标出来，避免预生成时重复登记同一处问题
  const done = new Map()
  for (const n of loadNotes(casePaths(dir))) {
    if (n.file !== target.name) continue
    const k = String(n.clause || '')
    done.set(k, (done.get(k) || 0) + 1)
  }

  const items = target.clauses.map((c) => {
    // 按句末标点切，保留句子原文；太短的（"如下："）不算候选引文
    const sents = String(c.text || '')
      .split(/(?<=[。；;！？?])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= QUOTE_MIN)
      .slice(0, maxSentences)
    return {
      clause: c.no,
      heading: String(c.heading || '').replace(/^\s*(第[零一二三四五六七八九十百\d]+条|\d{1,3}\s*[.．、])\s*/, '').trim(),
      chars: c.chars,
      noteCount: done.get(String(c.no)) || 0,
      sentences: sents,
      text: c.text,
    }
  })

  return {
    ok: true,
    file: target.name,
    total: items.length,
    pending: items.filter((x) => !x.noteCount).length,
    items,
    summary: `${target.name}：${items.length} 条，其中 ${items.filter((x) => !x.noteCount).length} 条还没有意见`,
  }
}

/**
 * 校验一批「AI 预生成的草稿」：只检查能不能落地，**不写台账**。
 *
 * 草稿必须由人勾选采纳后才进 notes.jsonl —— 预生成是帮人起草，不是替人签字。
 * 这里会把「引文不在原文里」「空泛话术」「三要素缺失」一次性挑出来，
 * 让界面能在采纳前就标红，而不是等提交时才被拒收。
 */
export function validateDrafts({ case: caseDirRaw, file, drafts, save = false }) {
  const dir = path.resolve(caseDirRaw)
  const files = loadClauses(dir)
  if (!files.length) throw new Error('还没有索引合同：先 lc_clause_index')
  const target = file ? files.find((x) => x.name === file || x.file === file) : files[files.length - 1]
  if (!target) throw new Error(`条款索引里没有这份文件：${file}`)
  // 条款编号有两种写法：字面的「第五条」和自动编号还原出来的「4」。
  // AI 和人都会混用，所以两边都登记，查找时再互相兜底。
  const byNo = new Map()
  for (const c of target.clauses) {
    const raw = String(c.no).replace(/\s+/g, '')
    byNo.set(raw, c)
    const n = clauseNoOf(raw)
    if (n) byNo.set(String(n), c)
  }

  const out = []
  for (const d of Array.isArray(drafts) ? drafts : []) {
    const given = String((d && d.clause) || '').replace(/\s+/g, '')
    let c = byNo.get(given)
    if (!c) {
      const n = clauseNoOf(given)
      if (n) c = byNo.get(String(n))
    }
    // 回填**合同里真实的编号**（「第一条」还是「4」），提交时才能和条款对上
    const no = c ? String(c.no).replace(/\s+/g, '') : given
    const problems = []
    if (!c) problems.push(`没有「${d && d.clause}」这一条`)
    const issue = String((d && d.issue) || '').trim()
    const fix = String((d && d.fix) || '').trim()
    // 不再按字数判（见 addNote 的同类说明）：只判「有没有内容」
    if (!issue && !fix) problems.push('问题与替换条文都为空')
    const vague = VAGUE.filter((v) => issue.includes(v) || fix.includes(v))
    if (vague.length) problems.push(`含空泛表述「${vague.join('、')}」`)
    const quote = String((d && d.quote) || '').trim()
    let quoteOk = null
    if (quote) {
      if (quote.length < QUOTE_MIN) problems.push(`引文不足 ${QUOTE_MIN} 字`)
      else if (c) {
        const hit = normSpace(c.text).includes(normSpace(quote))
        quoteOk = hit
        if (!hit) problems.push('引文没有在条款原文里逐字出现')
      }
    }
    out.push({
      clause: no,
      heading: c ? c.heading : '',
      level: (d && d.level) || '建议修改',
      issue,
      fix,
      quote,
      basis: String((d && d.basis) || '').trim(),
      quoteOk,
      ok: problems.length === 0,
      problems,
    })
  }
  const result = {
    ok: true,
    file: target.name,
    count: out.length,
    ready: out.filter((x) => x.ok).length,
    drafts: out,
    summary: `草稿 ${out.length} 条，可采纳 ${out.filter((x) => x.ok).length} 条`,
  }
  // AI 在对话里产出的草稿要能被界面读到：落到案件里的暂存文件，
  // 而不是让「生成」和「勾选」断在两处。仍然不写 notes.jsonl——采纳才写。
  if (save) {
    const dir2 = path.resolve(caseDirRaw)
    try {
      writeJsonAtomic(path.join(casePaths(dir2).state, 'note-drafts.json'), {
        file: target.name,
        at: nowIso(),
        drafts: out,
      })
      log(dir2, 'note-drafts', { count: out.length, ready: result.ready })
    } catch (e) {
      /* 暂存失败不影响校验结果 */
    }
  }
  return result
}

/** 读回 AI 暂存的草稿（.lawcase/note-drafts.json）。只读。 */
export function loadDrafts({ case: caseDirRaw }) {
  const dir = path.resolve(caseDirRaw)
  const d = readJson(path.join(casePaths(dir).state, 'note-drafts.json'), null)
  if (!d || !Array.isArray(d.drafts)) return { ok: true, count: 0, drafts: [], summary: '还没有 AI 草稿' }
  return {
    ok: true,
    file: d.file || '',
    at: d.at || '',
    count: d.drafts.length,
    drafts: d.drafts,
    summary: `AI 草稿 ${d.drafts.length} 条（${d.file || ''}）`,
  }
}

/** 清空 AI 草稿暂存（采纳/丢弃完就清，避免下次又摆出来）。 */
export function clearDrafts({ case: caseDirRaw, clause }) {
  const dir = path.resolve(caseDirRaw)
  const p = path.join(casePaths(dir).state, 'note-drafts.json')
  // 指定 clause 就只移除那一条（采纳/丢弃后不该再冒出来），不指定则整批清空
  if (clause != null && String(clause).trim()) {
    const d = readJson(p, null)
    if (!d || !Array.isArray(d.drafts)) return { ok: true, summary: '没有 AI 草稿' }
    const want = String(clause).replace(/\s+/g, '')
    const keep = d.drafts.filter((x) => String(x.clause || '').replace(/\s+/g, '') !== want)
    if (keep.length === d.drafts.length) return { ok: true, summary: '没有这条草稿' }
    writeJsonAtomic(p, Object.assign({}, d, { drafts: keep }))
    return { ok: true, remaining: keep.length, summary: `已移除 ${clause} 的草稿，剩 ${keep.length} 条` }
  }
  try {
    fs.rmSync(p, { force: true })
  } catch (e) {}
  return { ok: true, summary: '已清空 AI 草稿' }
}

// ============================================================================
// 条款审核判定（rulings）：记录「这条看过了，结论是什么」
// ============================================================================
//
// 为什么需要它：AI 草稿被「丢弃」不等于没发生。丢弃的真实含义是
// 「我看过了，这条不用改」——这是审核结论，必须留痕，否则：
//   1) 复核的人不知道这条是漏审还是看过觉得没问题
//   2) 下次重新生成草稿又把它捡回来，白做一遍
// 所以分成两种结论：
//   norevision（无需修改）—— 丢弃草稿时写
//   revision（需要修改）  —— 采纳并登记意见后写（意见本身进 notes.jsonl）

export const RULING_KINDS = {
  norevision: { label: '已审·无需修改', tone: 'ok' },
  revision: { label: '已审·需修改', tone: 'warn' },
}

const rulingsPath = (dir) => path.join(casePaths(dir).state, 'rulings.jsonl')

/** 读全部判定，按「文件+条款号」取最后一条（后写覆盖先写） */
export function loadRulings({ case: caseDirRaw } = {}) {
  const dir = path.resolve(String(caseDirRaw || '.'))
  const byKey = new Map()
  for (const r of readJsonl(rulingsPath(dir))) {
    if (r.__broken || !r.clause) continue
    byKey.set(String(r.file || '') + '#' + String(r.clause).replace(/\s+/g, ''), r)
  }
  // __deleted 的作废行会盖住原判定（与 notes.jsonl 同一套语义），作废后不再算数
  return [...byKey.values()].filter((r) => !r.__deleted)
}

/** 读全部判定**含作废记录**，供审计追溯"这条判定曾经存在过又被撤销" */
export function loadAllRulings({ case: caseDirRaw } = {}) {
  const dir = path.resolve(String(caseDirRaw || '.'))
  return readJsonl(rulingsPath(dir)).filter((r) => !r.__broken && r.clause)
}

/**
 * 作废一条判定（追加 __deleted 行，不删原始记录，可审计）。
 *
 * 什么时候需要它：判定写错了——例如把"未约定违约金"这种风险描述
 * 误记成「已审·无需修改」。改错不能靠删行，必须留痕，
 * 否则复核的人看不出"这条曾被判过、后来被推翻"。
 */
export function revokeRuling({ case: caseDirRaw, file, clause, reason = '', by = '' } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const c = readJson(casePaths(dir).caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}`)
  const no = String(clause || '').trim()
  if (!no) throw new Error('缺条款号：不知道作废哪一条判定')
  const why = String(reason || '').trim()
  if (why.length < 4) throw new Error('作废判定要写理由（≥4 字）：说明为什么原判定不成立')

  const f = String(file || '').trim()
  const key = f + '#' + no.replace(/\s+/g, '')
  const all = readJsonl(rulingsPath(dir))
  const sameKey = (r) => String(r.file || '') + '#' + String(r.clause || '').replace(/\s+/g, '') === key
  // 幂等：只要这条已经有过作废记录，就直接返回。
  // 不能只看"是否还有活着的记录"——原始那行永远活着（我们不删行），
  // 所以那样写会反复作废、堆出一串无意义的 __deleted 行（踩过）。
  // 幂等判断必须看**顺序**：只有当"最后一条记录已经是作废行"时才算已作废。
  // 只看"历史上出现过作废行"是错的——作废之后又新记了一条判定（例如重新丢弃一次），
  // 那新的这条仍然是可以作废的活记录（踩过：第二次丢弃的判定无论如何作废不掉）。
  const order = all.filter((r) => !r.__broken && sameKey(r))
  const lastRec = order[order.length - 1]
  if (lastRec && lastRec.__deleted) {
    return { ok: true, already: true, summary: `「${no}」的判定此前已作废，无需重复操作` }
  }
  const alive = order.filter((r) => !r.__deleted)
  if (!alive.length) throw new Error(`没有找到「${no}」的判定记录，无法作废`)

  const prev = alive[alive.length - 1]
  appendJsonl(rulingsPath(dir), {
    file: f,
    clause: no,
    __deleted: true,
    wasKind: prev.kind,
    reason: why,
    by: String(by || '').trim(),
    at: nowIso(),
  })
  log(dir, 'clause-ruling-revoke', { clause: no, wasKind: prev.kind })
  return { ok: true, summary: `已作废「${no}」原有的「${RULING_KINDS[prev.kind] ? RULING_KINDS[prev.kind].label : prev.kind}」判定` }
}

/**
 * 记一条判定。
 * @param {{case:string,file?:string,clause:string,kind:'norevision'|'revision',reason?:string,by?:string}} args
 */
export function ruleClause({ case: caseDirRaw, file, clause, kind, reason = '', by = '' } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}`)
  const no = String(clause || '').trim()
  if (!no) throw new Error('缺条款号：不知道这条判定针对哪一条')
  const k = String(kind || '').trim()
  if (!RULING_KINDS[k]) throw new Error(`判定只能是：${Object.keys(RULING_KINDS).join(' / ')}（收到「${kind}」）`)
  // 理由改为**选填**（用户 2026-10-26 明确要求「不用填理由」）。
  // 但有一条底线不能退：如果理由本身在描述风险（"未约定违约金""联系方式空白"），
  // 那这个判定就是自相矛盾的——把风险条款判成「无需修改」会放行风险。
  // 真机踩过：19 条风险条款被记成「无需修改」。所以这里只拦"理由与结论打架"，
  // 不再强制填写。
  const why = String(reason || '').trim()
  if (k === 'norevision' && why) {
    const RISK_WORDS = ['未约定', '没有约定', '缺乏', '失衡', '不利', '风险', '违约', '缺少', '未明确', '无法', '难以', '不能保障']
    const hit = RISK_WORDS.filter((w) => why.includes(w))
    if (hit.length >= 2) {
      const e = new Error(
        `这条理由读起来是在描述风险（含「${hit.join('、')}」），与「无需修改」的结论矛盾：${why.slice(0, 60)}…\n` +
          '如果这条确实有风险，请点「采纳（要修改）」并登记意见；如果确实不用改，理由改成说明（如"该标准已在附件一约定"）即可，也可以留空。'
      )
      e.code = 'ruling/reason-describes-risk'
      throw e
    }
  }
  const rec = {
    file: String(file || '').trim(),
    clause: no,
    kind: k,
    reason: why,
    by: String(by || '').trim(),
    at: nowIso(),
  }
  appendJsonl(rulingsPath(dir), rec)
  log(dir, 'clause-ruling', { clause: no, kind: k })
  return { ok: true, ruling: rec, summary: `已记录：${no} → ${RULING_KINDS[k].label}` }
}

/** 给界面用的汇总：哪些条款已有判定/意见，还剩多少没处理 */
export function rulingStatus({ case: caseDirRaw, file } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const files = loadClauses(dir)
  const target = file ? files.find((x) => x.name === file || x.file === file) : files[files.length - 1]
  if (!target) return { ok: true, total: 0, ruled: 0, noted: 0, pending: 0, items: [], summary: '还没有条款索引' }

  const norm = (x) => String(x || '').replace(/\s+/g, '')
  const rulings = new Map()
  for (const r of loadRulings({ case: dir })) {
    if (r.file && r.file !== target.name) continue
    rulings.set(norm(r.clause), r)
  }
  const noted = new Map()
  for (const n of loadNotes(casePaths(dir))) {
    if (n.file !== target.name) continue
    noted.set(norm(n.clause), (noted.get(norm(n.clause)) || 0) + 1)
  }

  const items = target.clauses.map((c) => {
    const key = norm(c.no)
    return {
      clause: c.no,
      heading: c.heading,
      noteCount: noted.get(key) || 0,
      ruling: rulings.get(key) || null,
    }
  })
  const ruled = items.filter((x) => x.ruling || x.noteCount).length
  return {
    ok: true,
    file: target.name,
    total: items.length,
    ruled,
    pending: items.length - ruled,
    items,
    summary: `${target.name}：${items.length} 条，已处理 ${ruled}，待处理 ${items.length - ruled}`,
  }
}

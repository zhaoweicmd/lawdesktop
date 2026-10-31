/**
 * redline.js — 把合同审核意见落回原 docx，输出「原文红色删除线 + 新文红色下划线」的副本。
 *
 * 刻意不用 Word 修订标记（w:ins / w:del）：Word 一律把修订塞进右侧批注框，正文只剩空行，
 * 而 revisionView 只是视图建议、不一定被遵守（WPS/Pages 各行其是）。改成静态格式后，
 * 任何软件打开都是「删的划掉、加的带下划线」，与用户提供的示例文件一致。
 *
 * 排版原则（v2，按用户反馈重做）：
 *   1. 同一段落内替换 —— 原文标删除、新文标插入都留在原段落里，段落数不变，版面不撑开
 *   2. 字体继承 —— 新文 run 复制原段正文的 rPr，不出现「新文字体变了」
 *   3. 段落标记删除 —— 被整条替换的多余段落标 w:pPr/rPr/w:del，接受修订后真正消失
 *   4. 只动目标段落，其余字节不变
 */
import fs from 'node:fs'
import path from 'node:path'
import { readZip } from './zip.js'
import { readJson, readJsonl, casePaths } from './store.js'
import { writeZip } from './zipwrite.js'
import { loadNotes, clauseNoOf } from './clause.js'
import { safeFileName } from './filename.js'
import { buildCommentsXml, anchorComment, registerComments, commentTextFor, AUTHOR as COMMENT_AUTHOR } from './comments.js'

const AUTHOR = 'LawCase 审核'
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** OOXML 规定 rPr 子元素的顺序，插入格式时必须按这个顺序排，否则 Word 可能报文档损坏 */
const RPR_ORDER = ['rFonts','b','bCs','i','iCs','caps','smallCaps','strike','dstrike','outline','shadow','emboss','imprint','noProof','snapToGrid','vanish','webHidden','color','spacing','w','kern','position','sz','szCs','highlight','u','effect','bdr','shd','fitText','vertAlign','rtl','cs','em','lang','eastAsianLayout','specVanish','oMath']

function buildRPr(rPrInner, add) {
  const parts = new Map()
  const re = /<w:([a-zA-Z]+)\b[^>]*(?:\/>|>[\s\S]*?<\/w:\1>)/g
  let m
  while ((m = re.exec(rPrInner || ''))) parts.set(m[1], m[0])
  for (const [tag, xml] of Object.entries(add || {})) parts.set(tag, xml)
  return [...parts.entries()]
    .sort((a, b) => {
      const ia = RPR_ORDER.indexOf(a[0])
      const ib = RPR_ORDER.indexOf(b[0])
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
    })
    .map(([, xml]) => xml)
    .join('')
}

/** 给一段 XML 里所有 run 叠加格式（delete: 删除线、insert: 下划线），保留原有字体字号 */
function markRuns(xml, add) {
  return String(xml).replace(/<w:r\b([^>]*)>([\s\S]*?)<\/w:r>/g, (all, attrs, inner) => {
    const m = inner.match(/^<w:rPr>([\s\S]*?)<\/w:rPr>/)
    const rPrInner = m ? m[1] : ''
    const rest = m ? inner.slice(m[0].length) : inner
    return `<w:r${attrs}><w:rPr>${buildRPr(rPrInner, add)}</w:rPr>${rest}</w:r>`
  })
}

/** 原文与新文的公共前缀/后缀——只把中间真正变动的部分划删除线，改几个字就只划几个字 */
export function splitDiff(oldText, newText) {
  const a = String(oldText || '')
  const b = String(newText || '')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  let j = 0
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++
  // 切点落在一句话中间（「7 个」/「7 个日」）时回退到最近的分句边界，
  // 否则读者会看到「7 个」后面接删除线再接「个工作日内」，来回绕
  // 只认标点，不认空格：「收到材料后 7 个」回退到空格会切出「7 个日内…」这种来回绕的断句
  const atBoundary = (ch) => /[，。；：！？、．.（(]/.test(ch || '')
  if (i > 0 && !atBoundary(a[i - 1])) {
    let k = i
    while (k > 0 && !atBoundary(a[k - 1])) k--
    i = k
  }
  if (j > 0 && !atBoundary(a[a.length - j])) {
    let k = j
    while (k > 0 && !atBoundary(a[a.length - k])) k--
    j = k
  }
  return {
    prefix: a.slice(0, i),
    oldMid: a.slice(i, a.length - j),
    newMid: b.slice(i, b.length - j),
    suffix: a.slice(a.length - j),
    same: i === a.length && i === b.length,
  }
}

const RED = '<w:color w:val="FF0000"/>'
const MARK_DEL = { strike: '<w:strike/>', color: RED }
const MARK_INS = { u: '<w:u w:val="single"/>', color: RED }



/** 取 run 内的纯文本 */
function runText(inner) {
  let s = ''
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g
  let m
  while ((m = re.exec(inner))) s += m[1] !== undefined ? m[1] : ''
  return s
}

/** 段落正文纯文本 */
function paraText(inner) {
  const pPr = inner.match(/^<w:pPr>[\s\S]*?<\/w:pPr>/)
  const body = pPr ? inner.slice(pPr[0].length) : inner
  let s = ''
  const re = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g
  let m
  while ((m = re.exec(body))) s += runText(m[1])
  return s
}

/** 选一个代表性 rPr：优先「文本最长的 run」的字符格式 */
function pickRPr(inner) {
  const pPr = inner.match(/^<w:pPr>[\s\S]*?<\/w:pPr>/)
  const body = pPr ? inner.slice(pPr[0].length) : inner
  let best = ''
  let bestLen = -1
  const re = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g
  let m
  while ((m = re.exec(body))) {
    const t = runText(m[1])
    const rPrM = m[1].match(/^<w:rPr>[\s\S]*?<\/w:rPr>/)
    const rPr = rPrM ? rPrM[0] : ''
    if (t.trim().length > bestLen && rPr) {
      bestLen = t.trim().length
      best = rPr
    }
  }
  return best
}



/**
 * 同段内替换：原段落 → pPr + del(原正文) + ins(新文第一行)；新文其余行各自成段（带同样 pPr 与字体）。
 * 返回段落 XML 数组。
 */
function replaceInPlace(pXml, lines, ids, stamp) {
  const mm = pXml.match(/^(<w:p(?:\s[^>]*)?>)([\s\S]*)<\/w:p>$/)
  if (!mm) return [pXml]
  const open = mm[1]
  const inner = mm[2]
  const pPrM = inner.match(/^<w:pPr>[\s\S]*?<\/w:pPr>/)
  const pPr = pPrM ? pPrM[0] : ''
  const body = pPrM ? inner.slice(pPrM[0].length) : inner
  const oldText = paraText(body)
  if (!oldText.trim()) return [pXml] // 空段不动

  const rPr = pickRPr(body)
  const run = (t, add) =>
    t ? markRuns(`<w:r>${rPr}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`, add || {}) : ''

  // 条款号（「第十四条」）是骨架，不能跟着一起划掉——新条文往往不带条号，划掉就断了。
  // 关键是**两边都要剥**：原文剥了、新文没剥的话，差异里会把条号当成"新增内容"，
  // 导出稿就变成「第二条 …第二条 …」——条号重复，等于废稿（踩过）。
  const noM = oldText.match(/^(\s*第[一二三四五六七八九十百]+条\s*)/)
  const clauseNo = noM ? noM[1] : ''
  const oldRest = clauseNo ? oldText.slice(clauseNo.length) : oldText
  let firstNew = lines[0] || ''
  if (clauseNo) {
    const nm = firstNew.match(/^(\s*第[一二三四五六七八九十百]+条\s*)/)
    if (nm) firstNew = firstNew.slice(nm[1].length)
  }

  // 与示例文件同一做法：没动的照原样，改动处划红色删除线，新文字标红色下划线
  const d = splitDiff(oldRest, firstNew)
  const pieces = [
    clauseNo ? run(clauseNo, {}) : '',
    run(d.prefix, {}),
    run(d.oldMid, MARK_DEL),
    run(d.newMid, MARK_INS),
    run(d.suffix, {}),
  ]
  const out = [`${open}${pPr}${pieces.join('')}</w:p>`]
  for (const line of lines.slice(1)) {
    out.push(`<w:p>${pPr}${run(line, MARK_INS)}</w:p>`)
  }
  return out
}

/** 只标删除的单段（多段条款里除首段外的段落） */
function deleteOnly(pXml, ids, stamp) {
  const mm = pXml.match(/^(<w:p(?:\s[^>]*)?>)([\s\S]*)<\/w:p>$/)
  if (!mm) return pXml
  const open = mm[1]
  const inner = mm[2]
  const pPrM = inner.match(/^<w:pPr>[\s\S]*?<\/w:pPr>/)
  const pPr = pPrM ? pPrM[0] : ''
  const body = pPrM ? inner.slice(pPrM[0].length) : inner
  if (!paraText(body).trim()) return pXml
  return `${open}${pPr}${markRuns(body, MARK_DEL)}</w:p>`
}

/** 把「第N条」定位到覆盖到的全部段落，并算出每段原文 */
/**
 * 轻量 XML 良构检查：标签栈配对。
 *
 * 不引 XML 解析库（插件零依赖），只做自闭合/起闭配对判断——
 * 足以挡住"表格被切坏"这类会让 Word 拒绝打开的结构错误。
 */
export function checkXmlBalanced(xml) {
  const stack = []
  const re = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>/g
  let m
  while ((m = re.exec(xml))) {
    const close = m[1]
    const name = m[2]
    const selfClose = m[4]
    if (selfClose || name.startsWith('?') || name.startsWith('!')) continue
    if (close) {
      if (!stack.length) return { ok: false, reason: `多余的闭合标签 </${name}>` }
      const top = stack.pop()
      if (top !== name) return { ok: false, reason: `标签未正确闭合：期望 </${top}>，实际 </${name}>` }
    } else {
      stack.push(name)
    }
  }
  if (stack.length) return { ok: false, reason: `未闭合的标签：<${stack[stack.length - 1]}>` }
  return { ok: true }
}

/** 中文数字（含十/百）转整数：「四」→4、「十八」→18、「一百零二」→102 */
export function cn2int(text) {
  const s = String(text || '').trim()
  if (/^\d+$/.test(s)) return Number(s)
  const d = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 两: 2 }
  let total = 0
  let num = 0
  for (const ch of s) {
    if (d[ch] !== undefined) num = d[ch]
    else if (ch === '十') { total += (num || 1) * 10; num = 0 }
    else if (ch === '百') { total += (num || 1) * 100; num = 0 }
  }
  return total + num
}

/**
 * 这条意见是「局部修改」还是「整条重写」？
 * 形如「第一阶段第4项改为：…」「第二阶段改为：…」——只换对应那一段，其余段落必须原样保留。
 * 返回 [] 表示不是局部修改（走整条替换）。
 */
export function parsePartial(fix) {
  const re = /第\s*([零一二三四五六七八九十百\d]+)\s*(项|阶段|款)\s*改为\s*[：:]\s*/g
  const hits = []
  let m
  while ((m = re.exec(String(fix || '')))) {
    hits.push({ num: cn2int(m[1]), unit: m[2], at: m.index, end: m.index + m[0].length })
  }
  if (!hits.length) return []
  const out = []
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]
    const stop = hits[i + 1] ? hits[i + 1].at : fix.length
    const text = String(fix).slice(h.end, stop).trim().replace(/[。；;]$/, '')
    if (text) out.push({ num: h.num, unit: h.unit, text })
  }
  return out
}

/** 在条款段落里找到局部修改要换的那一段；找不到返回 -1 */
/** 段落开头的编号：`4.` / `（2）` / `第二阶段：`——局部替换时必须保留，否则项目列表会断掉 */
export function paraPrefix(text) {
  const t = String(text || '').trim()
  const m = t.match(/^(\d+\s*[.．、]|（\d+）|第[一二三四五六七八九十]+(?:阶段|章|节)\s*[：:])/)
  return m ? m[0] : ''
}

export function findPartialTarget(seg, part) {
  for (let i = 1; i < seg.length; i++) {
    const t = String(seg[i].text || '').trim()
    if (part.unit === '项') {
      if (new RegExp('^' + part.num + '\\s*[.．、]').test(t)) return i
    } else if (part.unit === '阶段') {
      if (t.startsWith('第' + cnNum(part.num) + '阶段') || t.startsWith('第' + part.num + '阶段')) return i
    } else if (part.unit === '款') {
      if (t.startsWith('（' + part.num + '）')) return i
    }
  }
  return -1
}

/**
 * 找出第 no 条覆盖的段落区间。
 *
 * 两种合同形状都要认：
 *   - 字面「第X条」：条款号写在正文里
 *   - Word 自动编号：正文里**没有**条款号，只有 pPr 里的 <w:numPr>，序号是渲染时才出现的。
 *     对这类合同必须按「顶层编号段落」的先后顺序数，不能靠文字正则。
 */
export function locateClause(spans, no) {
  const want = typeof no === 'number' ? no : clauseNoOf(no)
  if (!want) return null
  // 表格单元格里的段落不算条款正文：合同常在末尾用表格排附件/报价单，
  // 若把它们算进"最后一条"，整条替换就会切断表格结构（Word 打不开）。
  // 这里在遇到表格段落时截断，让条款只覆盖表前的正文。
  const cutAtTable = (arr) => {
    const i = arr.findIndex((sp) => sp && sp.inTable)
    return i < 0 ? arr : arr.slice(0, i)
  }

  // 先试字面「第X条」
  let start = -1
  for (let k = 0; k < spans.length; k++) {
    const m = spans[k].text.match(/第([零一二三四五六七八九十百]+)条/)
    if (!m) continue
    const n = clauseNoOf(m[0])
    if (!n) continue
    if (start < 0) {
      if (n === want) start = k
    } else if (n > want) {
      return cutAtTable(spans.slice(start, k))
    }
  }
  if (start >= 0) return cutAtTable(spans.slice(start))

  // 再试自动编号：ilvl 0 且是数字/中文序号的那一段起算第 1 条
  // 注意：**表格里的自动编号段落不算条款**——合同末尾常用表格排附件，
  // 若把它们计成条款，条数会错位、整条替换还会切断表格（Word 打不开）。
  const tops = []
  for (let k = 0; k < spans.length; k++) {
    if (spans[k].inTable) continue
    const xml = spans[k].xml || ''
    const numPr = xml.match(/<w:numPr>([\s\S]*?)<\/w:numPr>/)
    if (!numPr) continue
    const ilvl = Number((numPr[1].match(/<w:ilvl w:val="(\d+)"/) || [])[1] || 0)
    if (ilvl !== 0) continue
    tops.push(k)
  }
  if (tops.length < want) return null
  const from = tops[want - 1]
  const to = want < tops.length ? tops[want] : spans.length
  return cutAtTable(spans.slice(from, to))
}

/** 解析修订意见文本：把「改为/建议改为/修改为」之类改成独立行 */
export function parseFix(target, fallback) {
  const raw = String(target || '').trim()
  const fb = String(fallback || '').trim()
  if (!raw) return fb ? [fb] : []
  const m = raw.match(/(?:^|[；;。\n])\s*(?:改为|建议改为|修改为|应改为|改为：|修正为)[：:]?\s*([\s\S]+)$/)
  const body = m ? m[1] : raw
  const lines = body
    .split(/\n+/)
    .map((s) => s.replace(/^[\s>*\-—•]+/, '').trim())
    .filter(Boolean)
  return lines.length ? lines : [body]
}

/**
 * 生成修订版 docx。
 * @param {{srcDocx:string,outDocx:string,edits:Array<{clauseNo:number,newText:string}>}} opts
 */
function doRevise({ srcDocx, outDocx, edits, comments: wantCommentsArg }) {
  const wantComments = wantCommentsArg !== false
  const zip = readZip(fs.readFileSync(srcDocx))
  const docXml = zip.readText('word/document.xml')
  const spans = []
  const re = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g
  let m
  // 同时记录每个段落的"表格深度"：表格单元格里的段落不能用整条替换，
  // 否则会切断 <w:tc> 结构（真机踩过：Word 直接打不开生成的文件）。
  let tableDepth = 0
  let lastPos = 0
  const trackTables = (from, to) => {
    const chunk = docXml.slice(from, to)
    for (const t of chunk.matchAll(/<(\/?)w:tbl\b/g)) {
      tableDepth += t[1] ? -1 : 1
    }
  }
  while ((m = re.exec(docXml))) {
    const xml = m[0]
    const inner = xml.replace(/^<w:p(?:\s[^>]*)?>/, '').replace(/<\/w:p>$/, '')
    // 段落之前的表格开闭，决定它是否在表格里
    trackTables(lastPos, m.index)
    // 段落内部也可能开/关表格（极少），先记当前深度
    spans.push({ start: m.index, end: m.index + xml.length, xml, text: paraText(inner), inTable: tableDepth > 0 })
    lastPos = m.index + xml.length
  }

  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const ids = { next: 9000 }
  const jobs = []


  // ---- 批注（2.44）--------------------------------------------------------
  // 关键顺序：批注锚点必须用**改之前**的段落偏移算出来，
  // 因为后面 jobs 会让 XML 长度变化，那时再定位就错位了。
  // 做法：先记下「每个 job 起点之前插了多少锚点」的校正量，最后统一换算。
  const comments = []
  const anchors = [] // {start, end, id}
  if (wantComments) {
    let nextId = 1
    const seen = new Set()
    for (const e of edits || []) {
      if (!e || !e.clauseNo) continue
      // 同一条款多条意见：合并成一条批注，避免右栏出现一堆几乎一样的框
      if (seen.has(e.clauseNo) && !(e.comment && e.comment.force)) {
        const prev = comments.find((c) => c.clauseNo === e.clauseNo)
        if (prev && e.issue && !prev.paras.includes(String(e.issue))) {
          prev.issue = [prev.issue, String(e.issue)].filter(Boolean).join('；')
          prev.paras = [commentTextFor({ clause: `第${cnNum(e.clauseNo)}条`, level: e.level, issue: prev.issue, fix: prev.fix, basis: prev.basis }), ...prev.paras.slice(1)]
        }
        continue
      }
      const seg = locateClause(spans, e.clauseNo)
      if (!seg || !seg.length) continue
      const issue = String(e.issue || e.problem || '').trim()
      // 判断要不要加批注，只看**原始意见**（issue 或显式给的 fix）。
      // 为什么不能看 newText：newText 永远存在（那正是修订本身），
      // 拿它当"有话说"的依据，任何一次纯改字都会冒出一个既没问题也没建议的空批注框。
      const rawFix = String(Array.isArray(e.fixLines) ? e.fixLines.join('；') : e.fix || '').trim()
      if (!issue && !rawFix) continue
      // comment 模式下正文不动，所以「建议」必须从意见里取（fix / newText），不能留空
      const isComment = e.apply === 'comment'
      // 「建议」优先用 fixLines，其次 fix，最后退回新条文本身 ——
      // 批注只写问题不写出路，审查人还得自己去翻意见表。
      const fix = String(Array.isArray(e.fixLines) ? e.fixLines.join('；') : e.fix || e.newText || '')
        .split(/\n+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .join('；')
        .trim()
      const id = nextId++
      const label = `第${cnNum(e.clauseNo)}条`
      comments.push({
        id,
        clauseNo: e.clauseNo,
        level: String(e.level || '').trim(),
        issue,
        fix,
        basis: String(e.basis || '').trim(),
        paras: [
          commentTextFor({
            clause: label,
            level: e.level,
            issue,
            fix,
            basis: e.basis,
            // 只批注不改正文时，措辞要说「建议改为」——正文还是原样，直接写"建议：<条文>"
            // 会让人以为这份文件里已经改好了。
            fixLabel: isComment ? '建议改为' : '建议',
          }),
        ],
      })
      // probe = 改完之后能在正文里认出来的那段文字。
      // 整条替换/插入模式认新条文；片段级修订认原段落里没被改动的前缀。
      const newFirst = String((Array.isArray(e.fixLines) ? e.fixLines[0] : e.newText) || '')
        .split(/\n+/)
        .map((x) => x.trim())
        .filter(Boolean)[0] || ''
      // 只取前 18 个字做锚点：太长会因标点/空格差异匹配不上
      const probe = newFirst.slice(0, 18)
      const fallbackProbe = String(seg[0].text || '').trim().slice(0, 12)
      anchors.push({ start: seg[0].start, end: seg[seg.length - 1].end, id, probe, fallbackProbe })
      seen.add(e.clauseNo)
    }
  }

  const applied = []
  const skipped = []

  // 同一条款可能有多条意见：必须合并成一个 job，否则替换区间重叠、文档会被切断
  const grouped = new Map()
  const partialTargets = new Map() // span.start → {span, lines}
  // 按 apply 分流：comment 的条款**完全不碰正文**，只走批注；
  // redline 的才进 jobs 去画删除线/下划线。这是用户 2026-11-01 的口径：
  // 「有些条款是批注，有些条款是修订」——两种形式要能在同一份稿子里共存。
  // 只有**显式** apply:'redline' 的才改正文。
  // 反过来判（apply !== 'comment' 才改）是错的：没传 apply 的调用方会被默认当成改正文，
  // 等于把"替客户改稿"变成默认行为——用户明确要求默认是批注。
  const redlineEdits = (edits || []).filter((e) => e && e.apply === 'redline')
  for (const e of redlineEdits) {
    const seg = locateClause(spans, e.clauseNo)
    if (!seg || !seg.length) {
      skipped.push({ clauseNo: e.clauseNo, reason: `正文中找不到「第${e.clauseNo}条」` })
      continue
    }
    // 局部修改：只换指定那一段，其余段落一律原样保留——整条删掉会把没提的内容一起抹了
    const partial = parsePartial(e.newText)
    if (partial.length) {
      let hit = 0
      for (const pt of partial) {
        const idx = findPartialTarget(seg, pt)
        if (idx < 0) {
          skipped.push({ clauseNo: e.clauseNo, reason: `第${e.clauseNo}条里找不到「第${pt.num}${pt.unit}」，未做局部修改` })
          continue
        }
        const key = seg[idx].start
        if (!partialTargets.has(key)) partialTargets.set(key, { span: seg[idx], lines: [], prefix: paraPrefix(seg[idx].text) })
        const t = partialTargets.get(key)
        if (!t.lines.includes(pt.text)) t.lines.push(pt.text)
        hit++
      }
      if (hit) applied.push({ clauseNo: e.clauseNo, paragraphs: seg.length, lines: hit, mode: 'partial' })
      continue
    }
    const lines = parseFix(e.newText, e.fallback)
    if (!lines.length) {
      skipped.push({ clauseNo: e.clauseNo, reason: '意见里没有可落地的条文文字' })
      continue
    }
    const key = seg[0].start
    if (!grouped.has(key)) grouped.set(key, { clauseNo: e.clauseNo, seg, lines: [], insertOnly: Boolean(e.insertOnly) })
    const g = grouped.get(key)
    if (e.insertOnly) g.insertOnly = true
    for (const ln of lines) if (!g.lines.includes(ln)) g.lines.push(ln)
  }

  for (const g of [...grouped.values()].sort((a, b) => a.seg[0].start - b.seg[0].start)) {
    const seg = g.seg

    // 两条路线，差别很大，不能混用：
    //
    // ① 整条重写（append 模式，诉讼案登记意见的老行为）：
    //    原文全部划掉、新条文接在最后一段。适合"这一条整体不要了，换成新的"。
    //
    // ② 只改首段（insert 模式，AI 草稿/多段条款用）：
    //    只把新条文加到首段，**其余段落原样保留**。
    //    为什么必须分开：像这份 17 段的「服务费用」条款，用 ① 会把 16 段
    //    真实约定全部划掉、只留一段新文——等于把合同改废了（真机验证时踩到）。
    //    AI 草稿本来就是"补充/修正某一句"，不是"整条删掉重写"。
    const insertMode = Boolean(g.insertOnly)
    const parts = []
    if (insertMode) {
      // 新条文接在首段后面，原首段内容保留（只做追加），其余段落完全不动
      parts.push(...replaceInPlace(seg[0].xml, g.lines, ids, stamp))
      for (let k = 1; k < seg.length; k++) parts.push(seg[k].xml)
    } else {
      for (let k = 0; k < seg.length; k++) {
        if (k === seg.length - 1) {
          parts.push(...replaceInPlace(seg[k].xml, g.lines, ids, stamp))
        } else if (k === 0) {
          // 首段带条款号：走 replaceInPlace 传空新文，只划正文、保留「第X条」这个骨架
          parts.push(...replaceInPlace(seg[k].xml, [''], ids, stamp))
        } else {
          parts.push(deleteOnly(seg[k].xml, ids, stamp))
        }
      }
    }
    jobs.push({ start: seg[0].start, end: seg[seg.length - 1].end, xml: parts.join('') })
    applied.push({ clauseNo: g.clauseNo, paragraphs: seg.length, lines: g.lines.length, mode: insertMode ? 'insert' : 'replace' })
  }

  for (const t of partialTargets.values()) {
    const withPrefix = t.lines.map((l) => {
      const body = /^(\d+\s*[.．、]|（\d+）|第[一二三四五六七八九十]+(?:阶段|章|节))/.test(l) ? l : t.prefix + l
      // 条文一句到底，末尾缺句号时补上——否则读起来像没写完
      return /[。；;：:！？!?]$/.test(body) ? body : body + '。'
    })
    jobs.push({ start: t.span.start, end: t.span.end, xml: replaceInPlace(t.span.xml, withPrefix, ids, stamp).join('') })
  }

  // 一份稿子可能「全部都是批注、一条都不改正文」——那是完全合法的产物，
  // 所以只有「既没落实修订、也没挂上批注」才算失败。
  const hasCommentWork = (comments || []).length > 0
  if (!applied.length && !hasCommentWork) {
    throw new Error('没有一条意见能定位到合同正文，未生成修订版')
  }

  jobs.sort((a, b) => b.start - a.start)
  let outXml = docXml
  for (const j of jobs) outXml = outXml.slice(0, j.start) + j.xml + outXml.slice(j.end)

  // ---- 落批注 --------------------------------------------------------------
  // 坐标问题：anchors 记的是**原文**偏移，jobs 已把 XML 改长/改短，原偏移不再成立
  // （实测：按坐标切，两条批注只插上第一条，第二条落进别的段落）。
  //
  // 解法：**按段落文本认段**，不按坐标。段落列表在改完之后重新扫一遍，
  // 用「这段的纯文本里有没有这句原文/新文」来配对。
  // 关键细节：要拿**去标签后的纯文本**比，不能拿 XML 比 ——
  // 一句话常被拆成多个 <w:r>（改动处两侧格式不同），XML 里是
  // 「…100 万元，</w:t>…<w:t>签订后 3 日内…」，直接 indexOf 整句永远找不到。
  const commentIds = []
  const anchoredParas = []
  if (comments.length) {
    const paras = []
    const pre = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g
    let pm
    while ((pm = pre.exec(outXml))) {
      const text = paraText(pm[0].replace(/^<w:p(?:\s[^>]*)?>/, '').replace(/<\/w:p>$/, ''))
      paras.push({ start: pm.index, end: pm.index + pm[0].length, text: text.replace(/\s+/g, '') })
    }
    const used = new Set()
    for (const a of anchors) {
      const keys = [a.probe, a.fallbackProbe].filter((x) => x && String(x).trim()).map((x) => String(x).replace(/\s+/g, ''))
      let hit = -1
      for (const k of keys) {
        // 只取前 8 个字比对：再长就会被标点/空格差异卡住
        const kk = k.slice(0, 8)
        if (kk.length < 2) continue
        hit = paras.findIndex((p, idx) => !used.has(idx) && p.text.includes(kk))
        if (hit >= 0) break
      }
      if (hit < 0) continue
      used.add(hit)
      anchoredParas.push({ id: a.id, ...paras[hit] })
    }
    for (const p of anchoredParas.sort((x, y) => y.start - x.start)) {
      const pxml = outXml.slice(p.start, p.end)
      const anchored = anchorComment(pxml, { start: 0, end: pxml.length, id: p.id })
      outXml = outXml.slice(0, p.start) + anchored + outXml.slice(p.end)
      commentIds.push(p.id)
    }
  }

  // 自检：删除线/下划线数量、段落与 rPr 标签配对
  const selfCheck = {
    strike: (outXml.match(/<w:strike\/>/g) || []).length,
    underline: (outXml.match(/<w:u w:val="single"\/>/g) || []).length,
    pOpen: (outXml.match(/<w:p[\s>]/g) || []).length,
    pClose: (outXml.match(/<\/w:p>/g) || []).length,
    rPrDiff: (outXml.match(/<w:rPr>/g) || []).length - (outXml.match(/<\/w:rPr>/g) || []).length,
    delTextInDel: 0,
  }
  if (selfCheck.pOpen !== selfCheck.pClose) {
    try { fs.writeFileSync('/tmp/redline-debug.xml', outXml) } catch {}
    throw new Error(`段落标签不配对（${selfCheck.pOpen}/${selfCheck.pClose}）`)
  }
  if (selfCheck.rPrDiff !== 0) throw new Error('w:rPr 标签不配对')

  // 最终防线：整份 XML 必须良构，否则 Word 会直接拒绝打开（"Word 在打开文件时遇到错误"）。
  // 真机踩过：条款定位把**表格单元格里**的段落当成普通正文替换，把 <w:tc> 的闭合顺序弄乱，
  // 生成的 docx zip 结构没问题、但 document.xml 不是合法 XML，Word 打不开。
  // 宁可报错让人改用片段级修订，也绝不产出打不开的文件。
  const wellFormed = checkXmlBalanced(outXml)
  if (!wellFormed.ok) {
    try { fs.writeFileSync('/tmp/redline-debug.xml', outXml) } catch {}
    throw new Error(
      `修订版 XML 结构被破坏（${wellFormed.reason}），已中止以免生成打不开的文件。` +
        '该条款可能包含表格/附件结构，请改用「片段级修订」逐句替换。'
    )
  }

  let settingsXml = null
  if (zip.has('word/settings.xml')) {
  }

  // 批注三件套：comments.xml + Content_Types 注册 + document 关系
  let contentTypesXml = null
  let docRelsXml = null
  const finalComments = comments.filter((c) => commentIds.includes(c.id))
  if (finalComments.length) {
    contentTypesXml = zip.has('[Content_Types].xml') ? zip.readText('[Content_Types].xml') : '<Types/>'
    docRelsXml = zip.has('word/_rels/document.xml.rels')
      ? zip.readText('word/_rels/document.xml.rels')
      : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    const reg = registerComments({ contentTypes: contentTypesXml, docRels: docRelsXml })
    contentTypesXml = reg.contentTypes
    docRelsXml = reg.docRels
  }

  const files = []
  for (const name of zip.names()) {
    if (name === 'word/document.xml') files.push({ name, data: Buffer.from(outXml, 'utf8') })
    else if (name === 'word/settings.xml' && settingsXml) files.push({ name, data: Buffer.from(settingsXml, 'utf8') })
    else if (name === '[Content_Types].xml' && contentTypesXml) files.push({ name, data: Buffer.from(contentTypesXml, 'utf8') })
    else if (name === 'word/_rels/document.xml.rels' && docRelsXml) files.push({ name, data: Buffer.from(docRelsXml, 'utf8') })
    else if (name === 'word/comments.xml' && finalComments.length) files.push({ name, data: Buffer.from(buildCommentsXml(finalComments, { dateIso: stamp }), 'utf8') })
    else files.push({ name, data: zip.read(name) })
  }
  if (finalComments.length) {
    if (!files.some((f) => f.name === 'word/comments.xml')) {
      files.push({ name: 'word/comments.xml', data: Buffer.from(buildCommentsXml(finalComments, { dateIso: stamp }), 'utf8') })
    }
    if (!zip.has('[Content_Types].xml')) files.push({ name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf8') })
    if (!zip.has('word/_rels/document.xml.rels')) files.push({ name: 'word/_rels/document.xml.rels', data: Buffer.from(docRelsXml, 'utf8') })
  }
  fs.mkdirSync(path.dirname(outDocx), { recursive: true })
  fs.writeFileSync(outDocx, writeZip(files))
  return {
    ok: true,
    out: outDocx,
    applied,
    skipped,
    selfCheck,
    comments: finalComments.map((c) => ({ id: c.id, clauseNo: c.clauseNo, level: c.level, text: c.paras[0] })),
  }
}

/** 23 → 「第二十三条」（用于回显） */
export function cnNum(n) {
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (n < 10) return d[n]
  if (n < 20) return '十' + (n % 10 ? d[n % 10] : '')
  if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '')
  const h = Math.floor(n / 100)
  const r = n % 100
  let out = d[h] + '百'
  if (r === 0) return out
  if (r < 10) return out + '零' + d[r]
  out += r < 20 ? '一' : d[Math.floor(r / 10)]
  out += '十' + (r % 10 ? d[r % 10] : '')
  return out
}


/**
 * 生成修订版。两种用法：
 *   reviseContract({ case })                      —— 从案件里读条款索引与审核意见
 *   reviseContract({ srcDocx, outDocx, edits })   —— 直接给定源文件与逐条改法
 */
export function reviseContract(opts = {}) {
  if (!opts.case) return doRevise(opts)

  const dir = path.resolve(opts.case)
  const cp = casePaths(dir)
  const caseJson = readJson(cp.caseJson, null)
  if (!caseJson) throw new Error(`不是 LawCase 案件：${dir}`)
  const store = readJson(cp.clauses, { files: [] })
  const files = store.files || []
  if (!files.length) throw new Error('还没有条款索引：先用 lc_clause_index 把合同拆成条款')
  const target = opts.file
    ? files.find((f) => f.file === path.resolve(opts.file) || f.name === path.basename(String(opts.file)))
    : files[files.length - 1]
  if (!target) throw new Error(`条款索引里没有这份文件：${opts.file}`)

  // 三条入口：
  //   1) 传 opts.edits：调用方已经把「新全文」算好了（片段级修订走这条）
  //   2) opts.source === 'drafts'：用**未采纳的 AI 草稿**直接出修订版
  //      （审核完就想看整份改动，不该被"先逐条登记"挡住）
  //   3) 不传：从已登记的正式意见（notes.jsonl）生成（整条替换，原有行为）
  // 片段级修订不能走第 2 条，因为它改的是条款里的一句话，不是整条重写。
  let notes = []
  let edits = []
  const noFix = []

  if (opts.source === 'drafts') {
    // 同一条款可能有多条草稿：合并成一段（与界面上「审核意见合并」同一套语义），
    // 否则后一条会覆盖前一条，等于悄悄丢意见。
    const dp = path.join(cp.state, 'note-drafts.json')
    const dd = readJson(dp, null)
    const list = (dd && Array.isArray(dd.drafts) ? dd.drafts : []).filter((x) => x && String(x.fix || '').trim())
    if (!list.length) throw new Error('没有可用的 AI 草稿：先点「AI 审核全部条款」，或改用已登记的意见出修订版')
    const byClause = new Map()
    for (const d of list) {
      const no = clauseNoOf(d.clause)
      if (!no) { noFix.push({ id: d.clause, reason: `条款号无法解析：${d.clause}` }); continue }
      if (!byClause.has(no)) byClause.set(no, [])
      byClause.get(no).push(d)
    }
    for (const [no, arr] of byClause) {
      // 多条时按顺序拼接，保留每条的替换条文
      const text = arr.map((x) => String(x.fix).trim()).filter(Boolean).join('\n')
      // insertOnly：AI 草稿是"补充/修正"，不是"整条删掉重写"。
      // 不加这个标记会把多段条款的其余段落全部划掉（真机踩过，等于把合同改废）。
      // issue/level 一并带下去：批注要写清「为什么改、风险多大」，不能只有新条文
      const merged = {
        issue: arr.map((x) => String(x.issue || '').trim()).filter(Boolean).join('；'),
        level: (arr.find((x) => x.level) || {}).level || '',
        basis: arr.map((x) => String(x.basis || '').trim()).filter(Boolean).join('；'),
      }
      // AI 草稿默认走批注：草稿是"建议"，还没被采纳，直接改正文越权。
      // 调用方明确要"已改好的稿子"时用 opts.draftsApply='redline' 覆盖。
      const applyMode = opts.draftsApply === 'redline' ? 'redline' : 'comment'
      if (text) edits.push({ clauseNo: no, newText: text, insertOnly: true, apply: applyMode, ...merged })
    }
    if (!edits.length) throw new Error('AI 草稿里没有可落地的条文（条款号都解析不出来）')
  } else if (Array.isArray(opts.edits) && opts.edits.length) {
    for (const e of opts.edits) {
      const no = typeof e.clauseNo === 'number' ? e.clauseNo : clauseNoOf(e.clauseNo)
      if (!no) { noFix.push({ id: e.noteId || '', reason: `条款号无法解析：${e.clauseNo}` }); continue }
      edits.push({
        clauseNo: no,
        newText: e.newText,
        fallback: e.fallback,
        issue: e.issue,
        level: e.level,
        basis: e.basis,
        apply: e.apply === 'redline' ? 'redline' : 'comment',
      })
    }
    if (!edits.length) throw new Error('没有可落实的修订：条款号都解析不出来')
  } else {
    notes = loadNotes(cp).filter((r) => r.file === target.name)
    if (Array.isArray(opts.noteIds) && opts.noteIds.length) {
      const want = new Set(opts.noteIds.map(String))
      notes = notes.filter((r) => want.has(String(r.id)))
      if (!notes.length) throw new Error(`没有可落实的审核意见：指定的意见编号都不存在（${opts.noteIds.join('、')}）`)
    }
    if (!notes.length) throw new Error(`没有可落实的审核意见：${target.name} 尚未登记任何意见`)

    for (const n of notes) {
      const no = clauseNoOf(n.clause)
      if (!no) { noFix.push({ id: n.id, reason: `条款号无法解析：${n.clause}` }); continue }
      edits.push({
        clauseNo: no,
        newText: n.fix,
        fallback: n.issue,
        noteId: n.id,
        issue: n.issue,
        level: n.level,
        basis: n.basis,
        // 'comment' = 正文不动只挂批注（默认）；'redline' = 真改
        apply: n.apply === 'redline' ? 'redline' : 'comment',
      })
    }
    if (!edits.length) throw new Error('没有可落实的审核意见：条款号都解析不出来')
  }

  // 文件名来自合同原名，可能含 Windows 非法字符（: * ? " < > |），统一清洗
  const outName = opts.outName || safeFileName(`修订版_${target.name}`, { fallback: '修订版.docx' })
  const outDocx = path.join(dir, 'out', safeFileName(outName, { fallback: '修订版.docx' }))
  const r = doRevise({
    srcDocx: target.file,
    outDocx,
    edits,
    // 批注默认开：它是"为什么改"的唯一载体。opts.comments === false 时退回纯红线
    comments: opts.comments !== false,
  })
  const clauseList = r.applied.map((a) => `第${cnNum(a.clauseNo)}条`)
  return {
    ok: true,
    file: outDocx,
    source: target.file,
    clauseList,
    notes: notes.length,
    applied: r.applied,
    skipped: [...r.skipped, ...noFix],
    selfCheck: r.selfCheck,
    comments: r.comments || [],
    // 字段名兼容两种调用方：老代码读 file，新代码读 outFile
    outFile: outDocx,
    summary:
      `已生成修订版《${path.basename(outDocx)}》｜落实 ${r.applied.length} 条（${clauseList.join('、')}）` +
      (r.comments && r.comments.length ? `｜批注 ${r.comments.length} 条` : '') +
      (r.skipped.length ? `｜跳过 ${r.skipped.length} 条` : ''),
  }
}

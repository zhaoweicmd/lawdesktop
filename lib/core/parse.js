import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { casePaths, readJson, writeJsonAtomic, readJsonl, log, nowIso } from './store.js'
import { readDocx } from './docx.js'
import { readXlsx } from './xlsx.js'
import { readPptx } from './pptx.js'
import { readDocText, readTxt } from './doc.js'
import { ocrImage } from './ocr.js'
import { readPdf, pageCharCounts } from './pdf.js'
import { parsePdfWithMineru, mineruAvailable, DEFAULT_TIER } from './mineru.js'
import { middleToUnits, contiguousRanges, compactRanges } from './middle.js'
import { ocrPdf, findOcr } from './ocr.js'

const TEXTY = new Set(['.docx', '.xlsx', '.pptx'])
const IMG = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp'])
export const PARSABLE = new Set(['.docx', '.xlsx', '.pptx', '.pdf', '.doc', '.txt', '.rtf', '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp'])

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)
}

/** 一页至少这么多个字符才算「有文本层」；少于它就是扫描页（与 looksScanned 同一门槛） */
const MIN_PAGE_TEXT = 20

function nums(a, b) {
  const out = []
  for (let p = a; p <= b; p++) out.push(p)
  return out
}

/**
 * PDF 路由：先用 pdftotext 抽一次，按**每页**字符数把页分成「有文本层」和「扫描页」，
 * 只把扫描页交给 MinerU（basic 档），MinerU 不可用才退本地 OCR。
 *
 * 为什么按页而不是按整份：诉讼卷宗常见「前 65 页是电子件、后面 200 页是扫描附件」。
 * 按整份判断会把 65 页免费文本也送进模型，或者反过来把 200 页扫描件当成已读。
 *
 * 任何降级都必须留痕（coverage.degraded）：本机 OCR 会把「2018年5月14日」读成「立月4日」，
 * 拿到的文本质量不同于 MinerU，不能让人无从判断。
 */
export async function parsePdfLocal(abs, {
  pdfEngine = 'auto',
  tier = DEFAULT_TIER,
  ocrDpi = 200,
  ocrMaxPages = 200,
  middlePath,
} = {}) {
  const probe = readPdf(abs)
  const totalPages = probe.pages
  if (!totalPages) throw new Error(`这个 PDF 一页都没抽出来，文件可能损坏：${abs}`)

  const chars = pageCharCounts(probe)
  const textPages = []
  const scanPages = []
  for (let p = 1; p <= totalPages; p++) {
    if ((chars.get(p) || 0) >= MIN_PAGE_TEXT) textPages.push(p)
    else scanPages.push(p)
  }

  const byPage = new Map()
  const engines = {}
  const degraded = []
  const blankPages = []
  let droppedNarration = 0
  const push = (units) => {
    for (const u of units) {
      const arr = byPage.get(u.page) || []
      arr.push(u)
      byPage.set(u.page, arr)
    }
  }
  const mark = (engine, pages) => {
    engines[engine] = (engines[engine] || []).concat(pages)
  }

  // 1) 有文本层的页：pdftotext 已经给了，零成本
  const textSet = new Set(textPages)
  if (textPages.length) {
    push(probe.units.filter((u) => textSet.has(u.page)))
    mark('pdf', textPages)
  }

  // 2) 扫描页：按连续区间上 MinerU，失败逐段退 OCR
  const wantMineru = pdfEngine === 'auto' || pdfEngine === 'mineru'
  const hasMineru = wantMineru && mineruAvailable()
  if (wantMineru && !hasMineru && scanPages.length) {
    degraded.push({
      engine: `mineru-${tier}`,
      code: 'engine_unavailable',
      pages: compactRanges(scanPages),
      reason: '找不到 mineru-kit（或用 LAWCASE_MINERU_KIT 指到它），改走本地 OCR',
    })
  }

  for (const [a, b] of contiguousRanges(scanPages)) {
    let done = false
    let lastErr = null
    if (hasMineru) {
      try {
        const out = middlePath ? `${middlePath}.${a}-${b}.json` : undefined
        const r = await parsePdfWithMineru(abs, { from: a, to: b, tier, outPath: out })
        const conv = middleToUnits(r.middle)
        const bad = conv.units.find((u) => u.page < a || u.page > b)
        if (bad) throw new Error(`页号越界：拿到第 ${bad.page} 页，超出请求区间 ${a}-${b}（引擎行为变了？）`)
        push(conv.units)
        for (const p of conv.blankPages) blankPages.push(p)
        droppedNarration += conv.droppedNarration
        mark(`mineru-${tier}`, nums(a, b))
        done = true
      } catch (e) {
        lastErr = e
        if (pdfEngine === 'mineru') throw e
        degraded.push({
          engine: `mineru-${tier}`,
          code: e.code || 'parse_failed',
          pages: `${a}-${b}`,
          reason: String(e.message || e).slice(0, 200),
        })
      }
    }
    if (done) continue

    if (!findOcr()) {
      throw new Error(
        `第 ${a}-${b} 页是扫描页：MinerU 用不了（${lastErr ? lastErr.message : '未安装或已禁用'}），本地也没找到 OCR 程序。` +
          `用 LAWCASE_OCR 指到可执行文件，或装 MinerU 4.x（mineru-kit）`,
      )
    }
    const cap = Math.max(1, Number(ocrMaxPages) || 200)
    for (let s = a; s <= b; s += cap) {
      const t = Math.min(b, s + cap - 1)
      const o = ocrPdf(abs, { dpi: ocrDpi, maxPages: cap, from: s })
      push(o.units)
      mark('ocr', nums(s, t))
      if (o.truncated && t < b) {
        degraded.push({ engine: 'ocr', code: 'ocr_batch_capped', pages: `${s}-${t}`, reason: `OCR 单批上限 ${cap} 页，已分批续跑` })
      }
    }
  }

  if (!byPage.size) throw new Error(`这份 PDF 没抽出任何内容（${totalPages} 页）`)

  // 3) 按页序装配 + 全局重编号（分块解析后这一步是必需的；单块时它也有序化作用）
  const units = []
  let n = 0
  for (let p = 1; p <= totalPages; p++) {
    for (const u of byPage.get(p) || []) {
      n += 1
      units.push({ n, page: p, text: u.text, ...(u.blockType ? { blockType: u.blockType } : {}) })
    }
  }

  const engineNames = Object.keys(engines).sort()
  const engine = engineNames.length === 1 ? engineNames[0] : `mixed(${engineNames.join('+')})`
  const coverage = {
    chunked: false,
    totalPages,
    textPages: textPages.length,
    scanPages: scanPages.length,
    engines: Object.fromEntries(engineNames.map((k) => [k, compactRanges(engines[k])])),
    blankPages: [...new Set(blankPages)].sort((x, y) => x - y),
    droppedNarration,
    degraded,
    complete: degraded.length === 0,
  }
  return { units, engine, coverage, pages: totalPages }
}

/** 定位解析结果里的一处位置。
 *  P<n>  = 第 n 段（含空段，按文档真实次序）
 *  N<n>  = 第 n 个非空段
 *  第n段 / 第n页 也可，按绝对段号处理
 * 返回 { ok, n, text, kind } */

/** 这段文本像不像 OCR 乱码：汉字占比过低 + 有内容，基本就是识别坏了 */
function looksGarbled(text) {
  const t = String(text || '').replace(/\s+/g, '')
  if (t.length < 40) return false
  const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length
  return cjk / t.length < 0.45
}

export function locate(parsed, locator) {
  const raw = String(locator || '').trim()
  if (!parsed || !parsed.units || !parsed.units.length) return { ok: false, why: '尚未解析该文件，无法定位' }
  const nums = raw.match(/(\d+)/)
  if (!nums) return { ok: false, why: `无法识别的位置写法「${raw}」（支持 P3 / N2 / 第3段 / 第2页）` }
  const num = Number(nums[1])
  const isNonEmpty = /^N|非空/.test(raw)
  const units = parsed.units
  // PDF / OCR 才有页码。写「第12页」就该按页找，不能当成第 12 段——
  // 一个 20 页的 PDF 有几百行，页与段混用会把出处指到完全不相干的地方
  const hasPage = units.some((u) => Number.isInteger(u.page))
  // 页码写法：P12 / p12 / 第12页 都算「按页定位」
  const looksLikePage = /页/.test(raw) || /(^|[^A-Za-z])[Pp]\s*\d/.test(raw)
  if (hasPage && looksLikePage) {
    const inPage = units.filter((u) => u.page === num)
    if (!inPage.length) {
      // 总页数优先取 record.pages：末页是空白页时，max(units.page) 会比真实页数少
      const max = Number.isInteger(parsed.pages) ? parsed.pages : units.reduce((m, u) => Math.max(m, u.page || 0), 0)
      const blank = parsed.coverage && Array.isArray(parsed.coverage.blankPages) && parsed.coverage.blankPages.includes(num)
      return {
        ok: false,
        why: `第 ${num} 页没有可定位的内容（这份文件共 ${max} 页）${blank ? '——该页是空白页' : ''}`,
      }
    }
    return {
      ok: true,
      n: inPage[0].n,
      text: inPage.map((u) => u.text).join('\n'),
      page: num,
      kind: 'page',
    }
  }
  // 写的是「页」但这份解析结果没有页码（docx 常见）：不能把「第2页」当成「第2段」，
  // 那会把出处指到完全不相干的地方。改为记下页码线索，交给 checkQuote 做全文兜底比对。
  if (!hasPage && looksLikePage) {
    return { ok: true, n: null, text: '', kind: 'page-unavailable', pageHint: num }
  }
  let target
  if (isNonEmpty) {
    const ne = units.filter((u) => String(u.text || '').trim())
    if (num < 1 || num > ne.length) return { ok: false, why: `第 ${num} 个非空段超出范围（共 ${ne.length} 个非空段）` }
    target = ne[num - 1]
  } else {
    if (num < 1 || num > units.length) return { ok: false, why: `第 ${num} 段超出范围（共 ${units.length} 段）` }
    target = units[num - 1]
  }
  return { ok: true, n: target.n, text: target.text, kind: isNonEmpty ? 'nonempty' : 'absolute' }
}

/** 出处核对：给的引文是否真的出现在该位置。
 *  quote 为空 → 只能确认「该位置存在且非空」，判定 unsupported（不算失效，但也不算核对通过）。 */
export function checkQuote(parsed, locator, quote) {
  const loc = locate(parsed, locator)
  if (!loc.ok) return { verdict: 'broken', why: loc.why }
  // 这份文件没有页码信息：退回全文比对。能对上就是 ok（位置写的是页，我们对不了页，
  // 但对得了字），对不上仍然报 broken——不能因为「对不了页」就放过。
  if (loc.kind === 'page-unavailable') {
    const q0 = String(quote || '').replace(/\s+/g, '').trim()
    if (!q0) {
      return { verdict: 'unsupported', why: `这份文件没有页码信息，且未提供原文引用，无法核对（位置写的是第 ${loc.pageHint} 页）`, excerpt: '' }
    }
    const hayAll = parsed.units.map((u) => String(u.text || '').replace(/\s+/g, '')).join('\n')
    if (hayAll.includes(q0)) {
      return { verdict: 'ok', n: null, excerpt: '', pageFallback: true, why: `这份文件没有页码信息，已在全文中找到该引文（位置「${locator}」对不了页）` }
    }
    return { verdict: 'broken', why: `这份文件没有页码信息，全文中也找不到该引文（位置「${locator}」）`, excerpt: '', quote: String(quote).slice(0, 80) }
  }
  if (!String(loc.text || '').trim()) return { verdict: 'broken', why: `第 ${loc.n} 段是空段，里面没有任何内容` }
  const q = String(quote || '').replace(/\s+/g, '').trim()
  if (!q) return { verdict: 'unsupported', why: `第 ${loc.n} 段存在且有内容，但未提供原文引用，无法逐字核对`, excerpt: loc.text.slice(0, 120) }
  const hay = String(loc.text).replace(/\s+/g, '')
  if (hay.includes(q)) return { verdict: 'ok', n: loc.n, excerpt: loc.text.slice(0, 120) }

  // 指定位置上没有，但全文里有：这是「位置写错了」，不是「引文造假」。
  // 两者必须分开——位置错可以改定位，引文假是根本问题。以前一律判 broken，
  // 用户看到「出处对不上」会以为事实是编的（真实案件里 F65/F69 就是这样：写了 P17，
  // 其实引文在第 1 页第 17 段，P 被当成了页）。
  if (q.length >= 8) {
    const where = parsed.units.filter((u) => String(u.text || '').replace(/\s+/g, '').includes(q))
    // 先看是不是「P17 其实想写第 17 段」：这种歧义在真实卷宗里很常见
    const numHint = Number((String(locator || '').match(/(\d+)/) || [])[1] || 0)
    const asUnit = numHint > 0 ? parsed.units[numHint - 1] : null
    if (asUnit && String(asUnit.text || '').replace(/\s+/g, '').includes(q)) {
      return {
        verdict: 'misplaced',
        n: asUnit.n,
        page: asUnit.page,
        excerpt: String(asUnit.text || '').slice(0, 120),
        why: `引文在第 ${asUnit.n} 段（第 ${asUnit.page || '-'} 页），不是第 ${numHint} 页——「${locator}」看起来是想写段号`,
        quote: String(quote).slice(0, 80),
        hint: `把定位改成「第${asUnit.n}段」或「P${asUnit.page || '-'}」`,
      }
    }
    if (where.length) {
      const h = where[0]
      return {
        verdict: 'misplaced',
        n: h.n,
        page: h.page,
        excerpt: String(h.text || '').slice(0, 120),
        why: `引文确实在文件里，但在第 ${h.page || '-'} 页第 ${h.n} 段，不是定位写的「${locator}」——建议把定位改成 P${h.page || '-'} 或第${h.n}段`,
        quote: String(quote).slice(0, 80),
      }
    }
  }
  // 这一页整体识别质量差（汉字比例低/乱码多）时，不能断言「引文造假」——
  // 只能是「机器读不出来」。这种必须交人工，而不是判 fail 说事实有问题。
  const pageText = loc.page != null
    ? parsed.units.filter((u) => u.page === loc.page).map((u) => u.text).join('')
    : loc.text
  if (looksGarbled(pageText)) {
    return {
      verdict: 'ocr-poor',
      why: `第 ${loc.page != null ? loc.page + ' 页' : loc.n + ' 段'}的识别质量差（汉字占比过低，像 OCR 乱码），机器无法比对引文——这是扫描识别的问题，不是事实本身有问题`,
      excerpt: String(pageText).slice(0, 160),
      quote: String(quote).slice(0, 80),
    }
  }
  return { verdict: 'broken', why: `第 ${loc.n} 段里找不到该引文，全文中也没有`, excerpt: loc.text.slice(0, 160), quote: String(quote).slice(0, 80) }
}

/** 解析一份材料，结果落到 .lawcase/cache/parse/<mid>.json */
export async function parseMaterial({
  case: caseDirRaw,
  id,
  force = false,
  source,
  ocrDpi = 200,
  ocrMaxPages = 200,
  pdfEngine = 'auto',
  tier = DEFAULT_TIER,
}) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const mats = readJson(cp.materials, null)
  const mid = String(id || '').trim().toUpperCase()
  let file = null
  if (mats && mats.files) file = mats.files.find((f) => f.mid === mid)
  if (source && !file) file = { mid: mid || 'SRC', rel: path.basename(String(source)), abs: path.resolve(String(source)) }
  if (!file) throw new Error(`材料清单里没有 ${mid || '(空)'}，先跑 lc_material_scan`)
  const abs = file.abs || path.join(String(mats?.source || ''), file.rel)
  if (!fs.existsSync(abs)) throw new Error(`源文件不存在：${abs}`)

  const ext = path.extname(abs).toLowerCase()
  if (!PARSABLE.has(ext)) {
    throw new Error(`${ext || '(无扩展名)'} 不在可解析范围（支持 .docx / .xlsx / .pptx / .pdf / .doc / .txt / 图片）`)
  }

  const buf = fs.readFileSync(abs)
  const h = sha1(buf)
  fs.mkdirSync(path.join(cp.cache, 'parse'), { recursive: true })
  const outPath = path.join(cp.cache, 'parse', `${file.mid}.json`)
  const prev = readJson(outPath, null)
  if (prev && prev.hash === h && !force) {
    return { ok: true, cached: true, mid: file.mid, type: ext.slice(1), engine: prev.engine || ext.slice(1), units: prev.units.length, path: outPath, summary: `${file.mid} 已解析过（内容未变），共 ${prev.units.length} 段` }
  }

  let units = []
  let engine = ext.slice(1)
  let ocrTruncated = false
  let coverage = null
  let pages = null
  if (ext === '.doc') units = await readDocText(abs)
  else if (ext === '.txt') units = readTxt(buf)
  else if (IMG.has(ext)) {
    const raw = ocrImage(abs)
    const lines = String(raw || '').split(/\r?\n/).map((t) => t.trim()).filter(Boolean)
    units = lines.map((t, i) => ({ n: i + 1, text: t, page: 1 }))
    engine = 'ocr-img'
  }
  else if (ext === '.docx') units = readDocx(buf).map((p) => ({ n: p.n, text: p.text }))
  else if (ext === '.xlsx') units = readXlsx(buf)
  else if (ext === '.pptx') units = readPptx(buf).units
  else if (ext === '.pdf') {
    // 逐页分类路由：文本层页走 pdftotext（零成本），扫描页才上 MinerU basic。
    // 按整份判断会把 65 页免费文本也送进模型，或把 200 页扫描件当成已读。
    const r = await parsePdfLocal(abs, {
      pdfEngine,
      tier,
      ocrDpi,
      ocrMaxPages,
      // 原始 middle_json 放 raw/ 子目录：listParsed 只扫顶层 *.json，
      // 否则这些引擎产物会被当成「已解析记录」列出来（mid/units 全是 undefined）
      middlePath: path.join(cp.cache, 'parse', 'raw', file.mid),
    })
    units = r.units
    engine = r.engine
    coverage = r.coverage
    pages = r.pages
  } else throw new Error(`${ext} 暂不支持`)

  const record = {
    mid: file.mid, rel: file.rel, abs, type: ext.slice(1), engine,
    ...(coverage ? { pages, coverage } : {}),
    ocrTruncated, hash: h,
    parsedAt: nowIso(), units,
    nonEmpty: units.filter((u) => String(u.text || '').trim()).length,
  }
  writeJsonAtomic(outPath, record)
  log(dir, { op: 'material-parse', mid: file.mid, type: ext.slice(1), engine, units: units.length, coverage })
  const preview = units.filter((u) => String(u.text || '').trim()).slice(0, 3).map((u) =>
    (Number.isInteger(u.page) ? `第${u.page}页/${u.n}: ` : `P${u.n}: `) + String(u.text).slice(0, 60),
  )
  const cov = coverage
    ? `｜${coverage.totalPages} 页：文本层 ${coverage.textPages}、扫描 ${coverage.scanPages}` +
      (coverage.blankPages.length ? `、空白 ${coverage.blankPages.length}` : '') +
      (coverage.droppedNarration ? `、丢弃幻觉 ${coverage.droppedNarration}` : '') +
      (coverage.degraded.length ? `｜降级 ${coverage.degraded.map((d) => `${d.engine}(${d.pages})`).join('；')}` : '')
    : ''
  return {
    ok: true, cached: false, mid: file.mid, type: ext.slice(1), engine,
    units: units.length, nonEmpty: record.nonEmpty, path: outPath, preview,
    ...(coverage ? { pages: coverage.totalPages, coverage } : {}),
    summary: `${file.mid} 解析完成：${units.length} 段（非空 ${record.nonEmpty}）｜引擎 ${engine}${cov}`,
  }
}

export function readParse(dir, mid) {
  const cp = casePaths(dir)
  return readJson(path.join(cp.cache, 'parse', `${String(mid).toUpperCase()}.json`), null)
}

export function listParsed(dir) {
  const cp = casePaths(dir)
  const d = path.join(cp.cache, 'parse')
  if (!fs.existsSync(d)) return []
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => {
    const r = readJson(path.join(d, f), null)
    return r ? { mid: r.mid, type: r.type, units: (r.units || []).length, nonEmpty: r.nonEmpty, parsedAt: r.parsedAt, hash: r.hash } : null
  }).filter(Boolean)
}

/**
 * 批量解析：把材料清单里能解析的一次性过一遍。
 * 用户最痛的场景就是「一堆 PDF 读不完」，逐份点名太慢。
 * 单份失败不影响其他份，失败原因逐条带回。
 */
export async function parseAll({ case: caseDirRaw, kind, limit = 50, force = false, ocrDpi = 200, pdfEngine = 'auto', tier = DEFAULT_TIER }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const mats = readJson(cp.materials, null)
  if (!mats || !mats.files || !mats.files.length) {
    throw new Error('材料清单是空的，先跑 lc_material_scan')
  }
  const k = String(kind || '').trim().toLowerCase().replace(/^\./, '')
  const list = mats.files
    .filter((f) => PARSABLE.has(path.extname(f.rel || f.name || '').toLowerCase()))
    .filter((f) => (k ? String(path.extname(f.rel || f.name || '')).toLowerCase() === `.${k}` : true))
    .slice(0, Math.max(1, Number(limit) || 50))

  const t0 = Date.now()
  const done = []
  const failed = []
  const timeline = []
  let parsed = 0
  let cached = 0
  const degraded = []
  for (let i = 0; i < list.length; i++) {
    const f = list[i]
    const ti = Date.now()
    try {
      const r = await parseMaterial({ case: dir, id: f.mid, force, ocrDpi, pdfEngine, tier })
      if (r.cached) cached += 1
      else parsed += 1
      const engine = r.engine || r.type
      const deg = (r.coverage && r.coverage.degraded) || []
      for (const d of deg) degraded.push({ mid: f.mid, ...d })
      done.push({ mid: f.mid, rel: f.rel, units: r.units, engine, cached: !!r.cached, degraded: deg.map((d) => d.code) })
      timeline.push({ mid: f.mid, engine, units: r.units, ms: Date.now() - ti, ok: true })
      // 每份落一行：大批量跑几分钟，没有进度就不知道是在干活还是卡死了
      log(dir, { op: 'material-parse-all:item', i: i + 1, total: list.length, mid: f.mid, engine, units: r.units, ms: Date.now() - ti, degraded: deg.length })
    } catch (e) {
      const error = String(e && e.message ? e.message : e).slice(0, 200)
      failed.push({ mid: f.mid, rel: f.rel, error })
      timeline.push({ mid: f.mid, ms: Date.now() - ti, ok: false, error })
      log(dir, { op: 'material-parse-all:item', i: i + 1, total: list.length, mid: f.mid, failed: error, ms: Date.now() - ti })
    }
  }
  const elapsedMs = Date.now() - t0
  log(dir, { op: 'material-parse-all', total: list.length, parsed, cached, failed: failed.length, degraded: degraded.length, elapsedMs })
  const byEngine = done.reduce((m, d) => ((m[d.engine] = (m[d.engine] || 0) + 1), m), {})
  return {
    ok: failed.length === 0,
    total: list.length,
    parsed,
    cached,
    failed,
    degraded,
    byEngine,
    elapsedMs,
    timeline: timeline.slice(0, 200),
    summary:
      `批量解析 ${list.length} 份：新解析 ${parsed}、已有缓存 ${cached}、失败 ${failed.length}` +
      (degraded.length ? `、降级 ${degraded.length} 处（${[...new Set(degraded.map((d) => d.code))].join('/')}）` : '') +
      `｜耗时 ${(elapsedMs / 1000).toFixed(1)}s` +
      (Object.keys(byEngine).length ? `｜${Object.entries(byEngine).map(([e, c]) => `${e} ${c}`).join(' / ')}` : ''),
  }
}

// 法条溯源：把「结论 → 引用的法条 → 条文原文 → 权威来源」这条链一次性摊开。
//
// 为什么单独一页：结论里写「依据刑法第224条」很容易，但交付前必须能回答四个问题：
//   ① 引的条号在法律台账里到底有没有（还是凭印象写的）
//   ② 有没有条文原文（只有条号＝无法核对，对方一问就哑）
//   ③ 来源到不到位（法宝/官方 vs 手工录入）
//   ④ 这条现在还生效吗、多久没复核了
// 全部是确定性判断，不调 LLM。

import path from 'node:path'

import { casePaths, readJson, readJsonl } from './store.js'
import { loadLaws, localVerdict, SOURCE_WEIGHT, SOURCE_LABEL } from './law.js'

const HIGH = '重大风险'
const MED = '建议修改'
const LOW = '提示'

/** 结论正文里点名的条号（「刑法第224条」「第二百二十四条」「第三十一条」）。
 *  注意「第三十一、第二百二十四条」这种并列写法：第一个没有「条」字，
 *  正则会把「第三十一」当成完整条号——所以要求后面紧跟「条」或分隔符才算。 */
function articleRefsInText(text) {
  const out = new Set()
  const s = String(text || '')
  const re = /第\s*([零一二三四五六七八九十百\d]+)\s*条/g
  let m
  while ((m = re.exec(s))) out.add(m[1])
  return [...out]
}

/** 法条的规范化条号：抽出其中的阿拉伯数字（「第2项（刑法第二百二十四条…）」→ 224） */
function articleNumbers(article) {
  const s = String(article || '')
  const nums = []
  // 中文数字与阿拉伯数字都转成阿拉伯数字，便于跨格式比较
  const re = /第?\s*([零一二三四五六七八九十百\d]+)\s*(?:条|项|款)/g
  let m
  while ((m = re.exec(s))) {
    const n = cn2intLoose(m[1])
    if (n != null) nums.push(n)
  }
  if (!nums.length) {
    const n = cn2intLoose(s.replace(/[^\u4e00-\u9fa5\d]/g, ''))
    if (n != null) nums.push(n)
  }
  return nums
}

/** 中文/阿拉伯数字 → 数字（只处理条号里会出现的形态） */
function cn2intLoose(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  const d = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 两: 2 }
  let total = 0
  let num = 0
  let seen = false
  for (const ch of s) {
    if (d[ch] !== undefined) {
      num = d[ch]
      seen = true
    } else if (ch === '十') {
      total += (num || 1) * 10
      num = 0
      seen = true
    } else if (ch === '百') {
      total += (num || 1) * 100
      num = 0
      seen = true
    }
  }
  if (!seen) return null
  return total + num
}

/**
 * 生成法条溯源核对表。
 * @param {{case: string}} opts
 */
export function lawTrace({ case: caseDirRaw } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  if (!caseDirRaw) throw new Error('case 不能为空：请给出案件工作目录绝对路径')
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}`)

  const laws = loadLaws(dir)
  const lawById = new Map(laws.map((l) => [l.id, l]))
  const findings = readJsonl(cp.findings).filter((f) => !f.__broken && !f.__revoked)

  const items = []
  const usedIds = new Set()

  for (const f of findings) {
    const lawId = String(f.law || '').trim()
    if (!lawId) {
      items.push({
        findingId: f.id,
        finding: String(f.text || '').slice(0, 60),
        lawId: '',
        lawTitle: '',
        article: '',
        level: MED,
        problems: ['结论没有标注所依据的法条编号：交付时无法核到具体条文'],
        quote: '',
        source: '',
        sourceLabel: '',
        status: 'no-law',
        verdict: null,
      })
      continue
    }
    usedIds.add(lawId)
    const law = lawById.get(lawId)
    if (!law) {
      items.push({
        findingId: f.id,
        finding: String(f.text || '').slice(0, 60),
        lawId,
        lawTitle: '',
        article: '',
        level: HIGH,
        problems: [`引用了 ${lawId}，但法律台账里没有这一条：可能是笔误或凭空写的条号`],
        quote: '',
        source: '',
        sourceLabel: '',
        status: 'missing-law',
        verdict: null,
      })
      continue
    }

    const verdict = localVerdict(law)
    const problems = verdict.items.map((i) => i.msg)

    // 结论正文点名的条号，是否与它引用的法条对得上。
    // 一条结论常同时提到几个条（「依刑法第二百三十一条、第三十一条…按第二百二十四条处罚」），
    // 所以只在「正文所有条号都对不上所引法条」时才报——那才说明引错了。
    const refNums = articleRefsInText(f.text).map((x) => cn2intLoose(x)).filter((n) => n != null)
    const ownNums = articleNumbers(law.article)
    if (refNums.length && ownNums.length && !refNums.some((n) => ownNums.includes(n))) {
      problems.push(
        `结论正文提到的条号（第${refNums.join('、第')}条）与引用的 ${lawId}「${law.article}」都不一致：可能是条号写错，或漏引了正文真正依据的那一条`
      )
    }

    // 结论自己写的回源定位 vs 法条台账里的来源
    if (!f.lawSource || (!f.lawSource.url && !f.lawSource.locator)) {
      problems.push('结论上没有回源定位（url 或「库名+条号」），无法证明查过权威原文')
    }
    if (!law.quote) {
      problems.push('法条台账里没有条文原文：只有条号，交付后对方一问就无法核对')
    }

    // 硬伤升到重大风险：废止、条号不存在、没有原文（等于无法核对）、条号引错
    const level = problems.some((p) => /废止|没有这一条|没有条文原文|都不一致/.test(p))
      ? HIGH
      : problems.length
        ? MED
        : LOW

    items.push({
      findingId: f.id,
      finding: String(f.text || '').slice(0, 60),
      lawId,
      lawTitle: law.title || '',
      article: law.article || '',
      level: problems.length ? level : 'pass',
      problems,
      quote: String(law.quote || ''),
      source: law.source || '',
      sourceLabel: SOURCE_LABEL[law.source] || law.source || '',
      status: law.status || '',
      verdict,
      // 这条法条的权威度：法宝 100 > 官方 90 > 公报 80 > 手工 40
      weight: SOURCE_WEIGHT[law.source] || 0,
    })
  }

  // 台账里有、但没有任何结论引用的法条（不是错，只是提示可以清理或漏引）
  const unused = laws.filter((l) => !usedIds.has(l.id)).map((l) => ({ id: l.id, title: l.title, article: l.article }))

  const byLevel = {}
  for (const it of items) {
    if (it.level === 'pass') continue
    byLevel[it.level] = (byLevel[it.level] || 0) + 1
  }
  const checked = items.filter((it) => it.level !== 'pass').length
  const missing = items.filter((it) => it.status === 'missing-law').length
  const noQuote = items.filter((it) => it.problems.some((p) => /没有条文原文/.test(p))).length
  const weakSource = items.filter((it) => it.weight && it.weight <= 40).length

  return {
    ok: true,
    scope: 'law-trace',
    note: '本表只做「引证是否可核」的机械核对：条号是否存在、原文是否有、来源级别、是否废止、是否过期。条文是否适用于本案事实，仍需人工判断。',
    caseId: c.caseId,
    findings: findings.length,
    laws: laws.length,
    items,
    unused,
    byLevel,
    stats: { checked, missing, noQuote, weakSource, unused: unused.length },
    summary:
      items.length === 0
        ? '还没有结论，无法做溯源'
        : checked
          ? `法条溯源 ${items.length} 条结论：${Object.entries(byLevel).map(([k, v]) => `${k} ${v}`).join('、')}` +
            (missing ? `｜${missing} 条引用了不存在的条号` : '') +
            (noQuote ? `｜${noQuote} 条缺原文` : '')
          : `法条溯源 ${items.length} 条结论全部可核（${laws.length} 条法条均有原文与来源）`,
  }
}

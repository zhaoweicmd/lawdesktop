// 五道验收（事实 / 法条 / 逻辑 / 格式 / 保密）
//
// 设计约束（来自需求：五道验收必须「能失败」）：
//   - 空案不能判通过。没有事实、没有结论的案件，五道里至少事实与逻辑两道必须 fail。
//   - 本模块**只读**。它给结论，不改状态——「通过」是人工签的，插件不能自封。
//   - 每条不通过都要能指到具体对象（F# / 工序 id / 文件名），不允许只说「有问题」。

import path from 'node:path'
import fs from 'node:fs'
import { casePaths, readJson, readJsonl, writeJsonAtomic, log, nowIso } from './store.js'
import { loadFacts } from './fact.js'
import { loadNotes } from './clause.js'
import { readParse, checkQuote } from './parse.js'
import { loadLaws, localVerdict, articleNumber } from './law.js'
import { unresolvedFatal } from './review.js'
import { checkStatus } from './checkoff.js'

const ID_PAT = /\b\d{17}[\dXx]\b/
const MOBILE_PAT = /\b1[3-9]\d{9}\b/
const CARD_PAT = /\b\d{16,19}\b/
const CASE_NO_PAT = /[（(]\d{4}[）)][\u4e00-\u9fa5]{0,8}\d{0,6}[\u4e00-\u9fa5]{0,4}\d+号/
const EMAIL_PAT = /[\w.+-]+@[\w-]+\.[\w.]+/

function scanSensitive(text) {
  const hits = []
  if (!text) return hits
  if (ID_PAT.test(text)) hits.push('身份证号')
  if (MOBILE_PAT.test(text)) hits.push('手机号')
  if (CASE_NO_PAT.test(text)) hits.push('案号')
  if (EMAIL_PAT.test(text)) hits.push('邮箱')
  // 银行卡与身份证/案号有重叠，单独标记且只作提示，不单独定罪
  if (CARD_PAT.test(text) && !ID_PAT.test(text)) hits.push('疑似卡号/长数字')
  return hits
}


/** 某条事实是否已在 checkoff 里标为「已核对」；没有核对台账时退回旧字段 */
function isChecked(checkState, id) {
  if (checkState && checkState.ids instanceof Set) return checkState.ids.has(String(id))
  return false
}

function issue(level, msg, ref) {
  return { level, msg, ref: ref || null }
}

/** 事实道：每条事实必须能追到出处（文件 + 定位），且未被标失效 */
function checkFacts(facts, caseDir, checkState = null) {
  const items = []
  if (!facts.length) {
    items.push(issue('fail', '事实台账为空：没有任何可追溯的事实，不能进入验收', 'facts.jsonl'))
    return { name: 'facts', title: '事实可追溯', status: 'fail', items }
  }
  for (const f of facts) {
    // 若该材料已解析，则把出处核到「段落级」：位置必须真实存在、引文必须真的在那
    const mid = f.source && f.source.materialId
    const parsed = mid ? readParse(caseDir, mid) : null
    if (parsed) {
      const q = checkQuote(parsed, f.source.locator, f.quote)
      if (q.verdict === 'broken') {
        items.push(issue('fail', `事实 ${f.id} 引文在文件里找不到（可能造假或摘错）：${q.why}`, 'facts.jsonl'))
        continue
      } else if (q.verdict === 'ocr-poor') {
        // 这一页 OCR 烂到无法比对：既不能判 fail（冤枉事实），也不能算 pass（没核到）。
        // 已人工核对过的，要写明「人工已核，机器帮不上」，别让人以为自己漏做了事。
        items.push(
          issue(
            'warn',
            `事实 ${f.id} ${q.why}` + (isChecked(checkState, f.id) ? '（该条你已人工核对，此项仅是机器比对不了）' : ''),
            'facts.jsonl'
          )
        )
      } else if (q.verdict === 'misplaced') {
        // 引文真实存在，只是定位写错——这是可以修的，不该判成「事实造假」
        items.push(
          issue('warn', `事实 ${f.id} ${q.why}` + (isChecked(checkState, f.id) ? '（内容已人工核对，只需改定位）' : ''), 'facts.jsonl')
        )
      } else if (q.verdict === 'unsupported') {
        items.push(
          issue('warn', `事实 ${f.id} 出处仅到段落级：${q.why}` + (isChecked(checkState, f.id) ? '（内容已人工核对）' : ''), 'facts.jsonl')
        )
      }
    }
    const hasSource = f.source && (f.source.file || f.source.locator)
    if (!hasSource) items.push(issue('fail', `事实 ${f.id} 没有出处（缺文件名或定位）`, f.id))
    if (f.verified === 'broken') items.push(issue('fail', `事实 ${f.id} 的来源已失效：${f.source && f.source.file}`, f.id))
    // 「是否已核对」只认 checkoff（逐条核对台账）——这是签字依据。
    // 以前读 f.verified，而 checkoff 不写这个字段，于是核完 100% 验收仍报「未复核」。
    else if (hasSource && !isChecked(checkState, f.id)) {
      items.push(issue('warn', `事实 ${f.id} 还没有人工核对（去「事实」页点「✓ 已核」）`, f.id))
    }
  }
  const fails = items.filter((i) => i.level === 'fail').length
  // 分两类计数：README 一句话说不清的，就让数字说清楚
  const unchecked = items.filter((i) => /还没有人工核对/.test(i.msg)).length
  const sourceItems = items.filter((i) => /引文|识别质量|定位|段落级|出处/.test(i.msg) && !/还没有人工核对/.test(i.msg))
  const sourceIssues = sourceItems.length
  // 其中有多少是「人已核对、只是机器比对不了」——这类不需要用户再做任何事
  const machineLimited = sourceItems.filter((i) => /已人工核对/.test(i.msg)).length
  return {
    name: 'facts',
    title: '事实可追溯',
    status: fails ? 'fail' : items.length ? 'warn' : 'pass',
    // 让界面能分开显示：「未核对 N 条」和「出处问题 M 条」是两件事
    counts: { unchecked, sourceIssues, machineLimited, fails },
    items,
  }
}

/** 法条道：引用法条必须带回源信息（M4 才做真回源，这里先卡结构） */
/**
 * 合同审核案的法条检查：看**意见的依据**（notes.jsonl 的 basis），不是结论台账。
 *
 * 为什么不能复用 checkLaw：那份只读 findings.jsonl，而合同审核案根本不写结论台账
 * （它的产出是条款意见）。真机后果：合同案永远报一条
 * 「没有任何带法条引用的结论」→ 验收卡在"待人工确认"，
 * 而且界面上没有任何地方能消掉它——用户反馈"找不到人工审核的地方"就是这个。
 */
function checkLawForNotes(caseDir, p, laws) {
  const rows = loadNotes({ notes: p.notes })
  const withBasis = rows.filter((r) => String(r.basis || '').trim())
  if (!rows.length) {
    return { name: 'law', title: '法条可回源', status: 'pass', items: [issue('pass', '还没有意见，法条这一道暂无可核内容', 'notes.jsonl')] }
  }
  if (!withBasis.length) {
    // 没有一条写依据：这是**提示**不是失败——合同审核本就不强制引法条
    return {
      name: 'law',
      title: '法条可回源',
      status: 'pass',
      items: [issue('pass', `本案 ${rows.length} 条意见都没有引用法条（合同审核不强制引法条；如需引用请在意见的「依据」里写）`, 'notes.jsonl')],
    }
  }
  const items = []
  const norm = (s) => String(s || '').replace(/[\s\u3000]/g, '')
  let unverified = 0
  for (const r of withBasis) {
    const ref = String(r.basis).trim()
    const law =
      laws.find((l) => norm(l.article) && norm(ref).includes(norm(l.article))) ||
      laws.find((l) => norm(l.title) && norm(ref).includes(norm(l.title)))
    if (!law) {
      // 没登记进法条台账：提示复核，不算硬失败（可能是惯例/常识，不是成文法）
      unverified += 1
      items.push(issue('warn', `${r.id}（${r.clause}）依据「${ref.slice(0, 40)}」未登记进法条台账，无法核验原文`, 'notes.jsonl'))
      continue
    }
    if (law.status === 'mcp-mismatch') {
      items.push(issue('fail', `${r.id} 依据的 ${law.id}「${law.title}${law.article}」与权威库原文不一致`, r.id))
      continue
    }
    if (!law.quote) {
      items.push(issue('fail', `${r.id} 引用的 ${law.id} 只有条号没有条文原文，等于没回源`, r.id))
    }
  }
  const fails = items.filter((i) => i.level === 'fail').length
  return {
    name: 'law',
    title: '法条可回源',
    status: fails ? 'fail' : unverified ? 'warn' : 'pass',
    items: items.length ? items : [issue('pass', `引用的 ${withBasis.length} 条依据都能回源`, 'notes.jsonl')],
  }
}

function checkLaw(findings, laws) {
  const items = []
  const cited = findings.filter((f) => f.lawRef || f.law)
  if (!cited.length) {
    items.push(issue('warn', '没有任何带法条引用的结论：若本案确实无法条争议可忽略，否则应补', 'findings.jsonl'))
    return { name: 'law', title: '法条可回源', status: 'warn', items }
  }
  const norm = (s) => String(s || '').replace(/[\s\u3000]/g, '')
  for (const f of cited) {
    const ref = String(f.law || f.lawRef).trim()
    const fid = f.id || f.findingId
    const law =
      laws.find((l) => l.id.toUpperCase() === ref.toUpperCase()) ||
      laws.find((l) => norm(l.title + l.article) === norm(ref)) ||
      laws.find((l) => norm(ref).includes(norm(l.article)) && norm(ref).length > norm(l.article).length + 2)
    if (!law) {
      items.push(issue('fail', `结论 ${fid} 引用的「${ref}」没有登记进法条台账（先 lc_law_add，否则无法核验）`, fid))
      continue
    }
    if (law.status === 'mcp-mismatch') {
      items.push(issue('fail', `结论 ${fid} 引用的 ${law.id}「${law.title}${law.article}」与北大法宝原文不一致：${law.mcpDetail || ''}`, fid))
      continue
    }
    if (!law.quote) {
      items.push(issue('fail', `结论 ${fid} 引用的 ${law.id} 只有条号没有条文原文，等于没回源`, fid))
      continue
    }
    const lv = localVerdict(law)
    for (const it of lv.items) items.push(issue(it.level, `结论 ${fid} → ${law.id}：${it.msg}`, fid))
    // 「已回源」不只看 mcp-verified 这一个字符串：
    // 法宝核过的状态有 mcp-verified / mcp-quote-from-pkulaw / quote-corrected 等多种，
    // 只认一种会把「来源：北大法宝 MCP」也报成「未经权威库核对」（自相矛盾，踩过）。
    // 判据改成「来源权重够 + 有原文」，与法条溯源页同一套口径。
    const verifiedStatus = /^mcp-/.test(String(law.status || '')) || law.status === 'quote-corrected'
    if (!verifiedStatus && lv.level === 'pass') {
      items.push(issue('warn', `结论 ${fid} 引用的 ${law.id} 未经权威库核对（来源：${law.sourceLabel || law.source}）`, fid))
    }
  }
  const fails = items.filter((i) => i.level === 'fail').length
  return { name: 'law', title: '法条可回源', status: fails ? 'fail' : items.length ? 'warn' : 'pass', items }
}

/** 逻辑道：结构自洽——有结论必须引事实；工序没走完不应出最终结论 */
function checkLogic(c, facts, findings, caseDir) {
  const items = []
  const proc = c.proc || []
  const open = proc.filter((x) => x.status !== 'done')
  // 未闭环的致命项独立判 fail：不依赖有没有工序/结论，它本身就是红线
  for (const f of unresolvedFatal(caseDir)) {
    items.push(issue('fail', `对抗复盘 ${f.round}/${f.aid} 判为致命仍未闭环（${f.target || '未标位置'}）：致命项必须先处理`, 'review.jsonl'))
  }
  if (findings.length && open.length) {
    items.push(issue('fail', `仍有 ${open.length} 道工序未完成（${open.map((x) => x.id).join('、')}），不应产出结论`, 'proc'))
  }
  const factIds = new Set(facts.map((f) => f.id))
  for (const f of findings) {
    const refs = f.factRefs || f.facts || []
    if (!refs.length) items.push(issue('fail', `结论 ${f.id || f.findingId} 没有引用任何事实编号`, f.id || f.findingId))
    for (const r of refs) {
      if (!factIds.has(r)) items.push(issue('fail', `结论 ${f.id || f.findingId} 引用了不存在的事实 ${r}`, f.id || f.findingId))
    }
  }
  if (!findings.length) items.push(issue('warn', '结论台账为空：还没有可验收的结论', 'findings.jsonl'))
  const fails = items.filter((i) => i.level === 'fail').length
  return { name: 'logic', title: '逻辑自洽', status: fails ? 'fail' : items.length ? 'warn' : 'pass', items }
}

/** 格式道：模板必备结构是否齐（结论台账要有表头、进度台账要有工序表） */
function checkFormat(caseDir, p) {
  const items = []
  const conc = readTextIfExists(p.conclusion)
  const prog = readTextIfExists(p.progress)
  if (!conc) items.push(issue('fail', '结论台账 missing', 'conclusion.md'))
  else if (!/\|\s*结论\s*\|/.test(conc)) items.push(issue('fail', '结论台账缺表头（| 结论 | 支撑事实 | 法律依据 | 状态 |）', 'conclusion.md'))
  if (!prog) items.push(issue('fail', '进度台账 missing', 'progress.md'))
  else if (!/##\s*工序表/.test(prog)) items.push(issue('fail', '进度台账缺「工序表」小节', 'progress.md'))
  const fails = items.filter((i) => i.level === 'fail').length
  return { name: 'format', title: '格式合规', status: fails ? 'fail' : 'pass', items }
}

function readTextIfExists(file) {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  } catch (e) {
    return null
  }
}

/** 保密道：外发前扫敏感信息。只提示，不定罪——是否脱敏由人判断 */
function checkConfidential(c, facts, findings) {
  const items = []
  const texts = []
  texts.push({ ref: 'title', text: c.title })
  texts.push({ ref: 'parties', text: c.parties })
  for (const f of facts) texts.push({ ref: f.id, text: f.text || f.content })
  for (const f of findings) texts.push({ ref: f.id || f.findingId, text: f.text || f.conclusion })
  const hits = []
  for (const t of texts) {
    const h = scanSensitive(t.text)
    if (h.length) hits.push({ ref: t.ref, kinds: h })
  }
  // 这一道不是「案件有错」：身份证号、案号、手机号本来就是案件内容，
  // 需要脱敏的是**对外交付的那一版**。所以聚合成一条提示，而不是每条报一次
  // （以前 13 条独立警告，看起来像 13 个缺陷，把真正的红项淹了）。
  if (!hits.length) return { name: 'confidential', title: '保密可脱敏', status: 'pass', items }
  const kinds = [...new Set(hits.flatMap((h) => h.kinds))]
  const sample = hits.slice(0, 6).map((h) => `${h.ref}（${h.kinds.join('/')}）`).join('、')
  items.push(
    issue(
      'warn',
      `本案台账含 ${hits.length} 处敏感信息（${kinds.join('、')}），如 ${sample}${hits.length > 6 ? ' 等' : ''}。` +
        '这些是案件内容本身，不是错误；对外交付前请确认是否需要脱敏（交付包里已按原样保留）',
      'facts/findings'
    )
  )
  return { name: 'confidential', title: '保密可脱敏', status: 'warn', items, counts: { sensitive: hits.length, kinds } }
}

/**
 * 跑五道验收。只读，不写任何文件、不改案件状态。
 * verdict：fail 有任何一道 fail → 'needs_fix'；全是 warn → 'needs_review'；全 pass → 'pass'
 */
/** 合同审核案·第一道：条款是否已索引（没有索引就谈不上逐条审） */
function checkClauses(caseDir, p) {
  const items = []
  const doc = readJson(p.clauses, null)
  const files = doc && Array.isArray(doc.files) ? doc.files : []
  const total = files.reduce((n, f) => n + (Array.isArray(f.clauses) ? f.clauses.length : 0), 0)
  if (!files.length) {
    items.push(issue('fail', '还没有索引任何合同条款：先用 lc_clause_index 把合同切条，否则无法逐条定位', 'clauses.json'))
  } else if (!total) {
    items.push(issue('fail', '条款索引为空：合同切分为 0 条，检查文件是否为有效 docx', 'clauses.json'))
  } else {
    items.push(issue('pass', `已索引 ${files.length} 份合同、${total} 条条款`, 'clauses.json'))
  }
  const fails = items.filter((i) => i.level === 'fail').length
  return { name: 'clauses', title: '条款已索引', status: fails ? 'fail' : 'pass', items }
}

/** 合同审核案·第三道：每条意见是否可直接执行（四要素 + 落到具体条款） */
function checkNotes(caseDir, p) {
  const items = []
  // 按 id 折叠：作废标记要盖住原件，否则删过的意见仍在验收里报错
  const rows = loadNotes({ notes: p.notes })
  if (!rows.length) {
    items.push(issue('fail', '还没有审核意见：合同审核的核心产出是意见清单，空清单不能交付', 'notes.jsonl'))
    return { name: 'notes', title: '意见可执行', status: 'fail', items }
  }

  const doc = readJson(p.clauses, null)
  const known = new Set()
  for (const f of (doc && doc.files) || []) for (const c of f.clauses || []) known.add(`${f.name}||${c.no}`)

  const VAGUE = ['建议完善', '建议补充', '进一步明确', '有待明确', '酌情', '视情况', '予以关注', '注意']
  let bad = 0
  for (const r of rows) {
    const tag = `${r.id}（${r.clause}）`
    if (!known.size || !known.has(`${r.file}||${r.clause}`)) {
      items.push(issue('warn', `${tag} 指向的条款不在索引里：可能条款编号已变，请复核`, 'notes.jsonl'))
    }
    if (!String(r.issue || '').trim()) { items.push(issue('fail', `${tag} 没有问题描述`, 'notes.jsonl')); bad++ }
    else if (String(r.issue).trim().length < 15) { items.push(issue('fail', `${tag} 问题描述过短：说不出「哪句话导致什么后果」`, 'notes.jsonl')); bad++ }
    if (!String(r.fix || '').trim()) { items.push(issue('fail', `${tag} 没有修改方案：只指出问题不给替换条文，等于让客户自己改`, 'notes.jsonl')); bad++ }
    else if (String(r.fix).trim().length < 15) { items.push(issue('fail', `${tag} 修改方案过短：必须是可直接替换的条文`, 'notes.jsonl')); bad++ }
    const hit = VAGUE.find((v) => String(r.issue || '').includes(v) || String(r.fix || '').includes(v))
    if (hit) { items.push(issue('fail', `${tag} 含空泛表述「${hit}」：交付意见必须能直接落地`, 'notes.jsonl')); bad++ }
  }

  // 分级是否真的用了三档：全标同一档说明没分级，降级为提示而非失败
  const levels = [...new Set(rows.map((r) => r.level))]
  if (rows.length >= 5 && levels.length === 1) {
    items.push(issue('warn', `${rows.length} 条意见全部标为「${levels[0]}」：没有分级，客户无法判断先改哪条`, 'notes.jsonl'))
  }
  items.push(issue('pass', `${rows.length} 条意见，分级：${levels.join('/')}`, 'notes.jsonl'))
  return { name: 'notes', title: '意见可执行', status: bad ? 'fail' : 'pass', items }
}

export function verifyCase({ case: caseDirRaw, checks, caseType } = {}) {
  if (!caseDirRaw) throw new Error('case 不能为空：请给出案件工作目录绝对路径')
  const caseDir = path.resolve(String(caseDirRaw))
  const p = casePaths(caseDir)
  const c = readJson(p.caseJson, null)
  if (!c) throw new Error(`该目录不是 LawCase 案件（缺少 ${path.join('.lawcase', 'case.json')}）：${caseDir}`)

  const factsView = loadFacts(caseDir)
  const facts = factsView.active
  const findings = readJsonl(p.findings).filter((f) => !f.__broken && !f.__revoked)
  const laws = loadLaws(caseDir)

  const type = caseType || c.caseType || 'litigation'
  // 核对台账（唯一口径）：哪些事实/结论已在面板上被人工核对
  let checkState = null
  try {
    if (typeof checkStatus !== 'function') throw new Error('checkStatus 未加载')
    const ck = checkStatus({ case: caseDir })
    checkState = {
      ids: new Set((ck.items || []).filter((x) => x.kind === 'fact' && x.result === 'ok').map((x) => x.id)),
      findingIds: new Set((ck.items || []).filter((x) => x.kind === 'finding' && x.result === 'ok').map((x) => x.id)),
      total: ck.total,
      done: ck.done,
      pending: ck.pending,
    }
  } catch (e) {}

  // 两种案型的检查项一一对应，只是判据不同：
  // 诉讼案看「事实能否追到出处」，合同审核案看「条款是否逐条审过、意见能否直接改」。
  const all =
    type === 'contract'
      ? [
          checkClauses(caseDir, p),
          checkLawForNotes(caseDir, p, laws),
          checkNotes(caseDir, p),
          checkFormat(caseDir, p),
          checkConfidential(c, facts, findings),
        ]
      : [
          checkFacts(facts, caseDir, checkState),
          checkLaw(findings, laws),
          checkLogic(c, facts, findings, caseDir),
          checkFormat(caseDir, p),
          checkConfidential(c, facts, findings),
        ]
  const want = Array.isArray(checks) && checks.length ? checks : null
  const picked = want ? all.filter((x) => want.includes(x.name)) : all

  // 人工豁免：某一道检查如果已经被人判定过「可以不处理」，就不再算作待确认。
  // 为什么需要：像「法条可回源」这种提示，合同审核案常常真的没有法条争议，
  // 一直挂着 warn 会让验收永远停在"待人工确认"，用户又无处消除。
  // 豁免必须留理由与判定人，写进 .lawcase/verify-waivers.json，可审计。
  const waivers = readJson(path.join(p.state, 'verify-waivers.json'), {}) || {}
  for (const ck of picked) {
    const w = waivers[ck.name]
    if (!w || !w.at) continue
    // 硬失败不允许豁免：那是真的缺东西（如没有意见），不能说"我忽略"
    if (ck.status === 'fail') continue
    ck.originalStatus = ck.status
    ck.status = 'pass'
    ck.waived = { reason: w.reason || '', by: w.by || '', at: w.at }
    ck.items = [{ level: 'pass', msg: `已由 ${w.by || '人工'} 判定可忽略（${w.reason || '未填理由'}）`, ref: null }]
  }

  const fails = picked.filter((x) => x.status === 'fail')
  const warns = picked.filter((x) => x.status === 'warn')
  const verdict = fails.length ? 'needs_fix' : warns.length ? 'needs_review' : 'pass'

  return {
    ok: fails.length === 0,
    caseId: c.caseId,
    caseType: type,
    title: c.title,
    dir: caseDir,
    checkedAt: nowIso(),
    verdict,
    summary: fails.length
      ? `${fails.length} 道未通过（${fails.map((f) => f.title).join('、')}），不能进入外发`
      : warns.length
        ? `无硬性失败，但有 ${warns.length} 道待人工确认（${warns.map((w) => w.title).join('、')}）`
        : '五道全过',
    checks: picked,
    mustFix: fails.flatMap((f) => f.items.filter((i) => i.level === 'fail')),
    // 显式声明：本次调用没有改动案件状态。状态只能由人确认后另调接口改。
    stateUnchanged: true,
    brokenLines: factsView.all.filter((f) => f.__broken).length,
    revokedFacts: factsView.revoked.length,
  }
}

/**
 * 人工豁免某一道验收检查（留理由与判定人，可撤销）。
 *
 * 只允许豁免 warn：fail 是真的缺东西（没意见、法条抄错），不能说"我忽略"。
 */
export function waiveCheck({ case: caseDirRaw, name, reason, by, revoke = false } = {}) {
  const caseDir = path.resolve(String(caseDirRaw || ''))
  const p = casePaths(caseDir)
  const c = readJson(p.caseJson, null)
  if (!c) throw new Error(`该目录不是 LawCase 案件：${caseDir}`)
  const key = String(name || '').trim()
  if (!key) throw new Error('缺要豁免的检查项名称（如 law）')
  const file = path.join(p.state, 'verify-waivers.json')
  const all = readJson(file, {}) || {}

  if (revoke) {
    delete all[key]
    writeJsonAtomic(file, all)
    log(caseDir, { op: 'verify-waive-revoke', check: key })
    return { ok: true, summary: `已取消「${key}」的忽略标记` }
  }

  const why = String(reason || '').trim()
  if (why.length < 4) throw new Error('忽略要给理由（≥4 字）：否则和"漏看"分不出来')

  // 硬失败不允许豁免
  const r = verifyCase({ case: caseDir })
  const hit = r.checks.find((x) => x.name === key)
  if (hit && hit.status === 'fail') {
    throw new Error(`「${hit.title}」是真失败（缺内容），不能忽略：请先补上，再跑验收`)
  }

  all[key] = { reason: why, by: String(by || '').trim(), at: nowIso() }
  writeJsonAtomic(file, all)
  log(caseDir, { op: 'verify-waive', check: key, by: by || '' })
  return { ok: true, summary: `已忽略「${hit ? hit.title : key}」：${why}` }
}

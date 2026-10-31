// 核对签字：把「人工逐页校对」这件事记进台账。
//
// 为什么要它：交付前那句「都核对过了」，以前只存在于口头。
// 现在每条台账（事实/结论/材料）都能逐条打上核对结论，并且记下
// **核对时的内容指纹**——签字页会重新算一次指纹，对不上就写「核对后被修改」。
// 这样签的就不是「一个名字」，而是「这一版内容 + 谁看过 + 什么时候」。
//
// 本文件不调 LLM，纯函数可单测。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { casePaths, readJson, readJsonl, appendJsonl, nowIso, log } from './store.js'

/** 三本可核对的台账 */
export const CHECK_KINDS = {
  fact: { label: '事实台账', file: 'facts.jsonl' },
  finding: { label: '结论台账', file: 'findings.jsonl' },
  material: { label: '材料清单', file: 'materials.json' },
}

/** 核对结论：三选一，不给「默认通过」——没点就是没核 */
export const RESULTS = {
  ok: { label: '已核对', tone: 'ok' },
  fix: { label: '需修改', tone: 'warn' },
  doubt: { label: '有疑问', tone: 'err' },
}

const RESULT_KEYS = Object.keys(RESULTS)

function loadCase(dir) {
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}（缺 .lawcase/case.json）`)
  return { cp, c }
}

/** 核对记录单独一个文件：追加写，不覆盖任何原始行 */
export function checkoffPath(cp) {
  return path.join(cp.state, 'checkoff.jsonl')
}

/**
 * 规范化 JSON：键递归排序后序列化，用于算内容指纹。
 *
 * ⚠ 这里踩过一个能盖章的坑（2026-10-31）：
 *   旧写法 `JSON.stringify(v, Object.keys(v).sort())` 把**键名数组**当 replacer，
 *   而 replacer 数组只保留"出现在数组里的键"，**嵌套对象的键不在顶层数组里**
 *   ⇒ `{source:{file,locator}}` 被序列化成 `"source":{}`。
 *   后果：lc_fact_amend 改了出处定位，指纹却没变，签字单照打「已核对」，
 *   等于给「事后改证」盖章。必须递归排序，不能靠 replacer。
 */
function normJson(v) {
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object') {
      const out = {}
      for (const k of Object.keys(x).sort()) {
        if (x[k] === undefined) continue
        out[k] = walk(x[k])
      }
      return out
    }
    return x
  }
  return JSON.stringify(walk(v))
}

/** 内容指纹：只取会被人核对的那几个字段，避免 updatedAt 之类抖动导致误报 */
function fingerprint(kind, item) {
  const pick = (o, keys) => {
    const out = {}
    for (const k of keys) if (o[k] !== undefined) out[k] = o[k]
    return out
  }
  const payload =
    kind === 'material'
      ? pick(item, ['mid', 'name', 'rel', 'size', 'sha256', 'isLatest', 'accepted'])
      : pick(item, ['id', 'text', 'factRefs', 'law', 'lawSource', 'verified', 'source'])
  return crypto.createHash('sha256').update(normJson(payload)).digest('hex').slice(0, 16)
}

/** 读三本台账的条目（已作废的行不算） */
export function loadCheckItems(caseDirRaw, kind) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const { cp } = loadCase(dir)
  const k = String(kind || '')
  if (!CHECK_KINDS[k]) throw new Error(`kind 只能是 ${Object.keys(CHECK_KINDS).join(' / ')}（收到「${kind}」）`)
  if (k === 'fact') {
    // 必须按 id 合并：修正（lc_fact_amend）是追加一条同 id 的覆盖记录，
    // 直接读原始行会把同一个 F1 算成两条。
    // 这里自己合并而不是调 loadFacts()：checkoff ↔ fact 互相 import 会成环，
    // 环里的函数在部分加载顺序下是 undefined，错误会被 catch 吞掉、统计变 0（踩过）。
    const byId = new Map()
    for (const f of readJsonl(cp.facts)) {
      if (f.__broken || !f.id) continue
      byId.set(f.id, { ...(byId.get(f.id) || {}), ...f })
    }
    const active = [...byId.values()].filter((f) => !f.__revoked)
    return active.map((r) => ({
      id: r.id,
      text: r.text,
      extra: r.source ? `${r.source.file} · ${r.source.locator}` : '',
      raw: r,
    }))
  }
  if (k === 'finding') {
    // 结论按 id 合并（保持与事实一致的口径），并把同 id 的后续记录视为最新版
    const byId = new Map()
    for (const r of readJsonl(cp.findings)) {
      if (r.__broken || !r.id) continue
      byId.set(r.id, { ...(byId.get(r.id) || {}), ...r })
    }
    return [...byId.values()]
      .filter((r) => !r.__revoked)
      .map((r) => ({ id: r.id, text: r.text, extra: (r.factRefs || []).join('、'), raw: r }))
  }
  const mats = readJson(cp.materials, null) || { files: [] }
  return (mats.files || []).map((f) => ({
    id: f.mid,
    text: f.rel || f.name,
    extra: f.isLatest === false ? `旧版（最新为 ${f.latestName || '—'}）` : '最新',
    raw: f,
  }))
}

/** 已登记过的核对结论：同一 id 取最后一次 */
function readChecks(cp) {
  const rows = readJsonl(checkoffPath(cp)).filter((r) => !r.__broken)
  const last = new Map()
  for (const r of rows) last.set(`${r.kind}:${r.id}`, r)
  return { rows, last }
}

/**
 * 给一条台账打核对结论。
 * @param {{case:string, kind:string, id:string, result:string, by?:string, note?:string}} args
 */
export function checkItem({ case: caseDirRaw, kind, id, result, by = '', note = '' } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const { cp, c } = loadCase(dir)
  const k = String(kind || '')
  const res = String(result || '')
  if (!CHECK_KINDS[k]) throw new Error(`kind 只能是 ${Object.keys(CHECK_KINDS).join(' / ')}（收到「${kind}」）`)
  if (!RESULT_KEYS.includes(res)) {
    throw new Error(`核对结论只能是 ${RESULT_KEYS.map((x) => `${x}（${RESULTS[x].label}）`).join(' / ')}（收到「${result}」）`)
  }
  const items = loadCheckItems(dir, k)
  const item = items.find((x) => x.id === String(id))
  if (!item) {
    throw new Error(`${CHECK_KINDS[k].label}里没有 ${id}（共 ${items.length} 条：${items.slice(0, 5).map((x) => x.id).join('、') || '无'}）`)
  }
  if (res !== 'ok' && !String(note || '').trim()) {
    throw new Error(`结论是「${RESULTS[res].label}」，必须写一句说明（note）：签字页上别人要知道问题在哪`)
  }
  const who = String(by || '').trim() || String((c.owner && c.owner.name) || '').trim()
  if (!who) throw new Error('核对人要写（by）：签字页上没有名字就等于没人负责')

  const rec = {
    at: nowIso(),
    kind: k,
    id: String(id),
    result: res,
    by: who,
    note: String(note || '').trim() || undefined,
    // 核对时的内容指纹：签字时重算，对不上就说明"核对后又改过"
    hash: fingerprint(k, item.raw),
  }
  appendJsonl(checkoffPath(cp), rec)
  log(dir, 'checkoff', { kind: k, id: String(id), result: res })
  return {
    ok: true,
    record: rec,
    summary: `${item.id} 已标为「${RESULTS[res].label}」（${who}）${rec.note ? '：' + rec.note : ''}`,
  }
}

/** 三本台账的核对进度 */
export function checkStatus({ case: caseDirRaw } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const { cp, c } = loadCase(dir)
  const { last } = readChecks(cp)
  const out = { kinds: {}, total: 0, done: 0, pending: 0, fix: 0, doubt: 0, stale: 0, items: [] }
  // 合同审核案**不核材料台账**（用户 2026-11-01）：
  //   合同审核的材料是一堆合同/模板/附件，逐份点「已核」没有业务含义——
  //   真正要看的是条款、意见、修订版。诉讼案才需要逐份核卷宗材料。
  const wantedKinds = c && c.caseType === 'contract'
    ? Object.keys(CHECK_KINDS).filter((k) => k !== 'material')
    : Object.keys(CHECK_KINDS)
  for (const kind of wantedKinds) {
    const items = loadCheckItems(dir, kind)
    const stat = { kind, label: CHECK_KINDS[kind].label, total: items.length, done: 0, fix: 0, doubt: 0, pending: 0, stale: 0 }
    for (const it of items) {
      const rec = last.get(`${kind}:${it.id}`)
      const changed = Boolean(rec) && rec.hash !== fingerprint(kind, it.raw)
      if (!rec) stat.pending += 1
      else {
        stat.done += 1
        if (rec.result === 'fix') stat.fix += 1
        else if (rec.result === 'doubt') stat.doubt += 1
        if (changed) stat.stale += 1
      }
      out.items.push({
        kind,
        id: it.id,
        text: it.text,
        extra: it.extra,
        result: rec ? rec.result : null,
        by: rec ? rec.by : null,
        at: rec ? rec.at : null,
        note: rec ? rec.note || '' : '',
        changed,
      })
    }
    out.kinds[kind] = stat
    out.total += stat.total
    out.done += stat.done
    out.pending += stat.pending
    out.fix += stat.fix
    out.doubt += stat.doubt
    out.stale += stat.stale
  }
  return {
    ok: true,
    ...out,
    // 三段色（界面 U3）：把「人核过且内容没变 / 从没核过 / 核过又被改」分开。
    // 为什么必须分开：stale 才是交付时最大的雷，而它和 done 在进度条上是同一个颜色，
    // 等于把风险画成了正常。三数相加恒等于 total（有测试钉住）。
    tri: triState(out),
    summary:
      `核对进度：已核 ${out.done}/${out.total}` +
      (out.pending ? `｜未核 ${out.pending}` : '') +
      (out.fix ? `｜需修改 ${out.fix}` : '') +
      (out.doubt ? `｜有疑问 ${out.doubt}` : '') +
      (out.stale ? `｜核对后被修改 ${out.stale}` : ''),
  }
}

/**
 * 三段色计数。
 * 绿 verified  = 人核过、且内容自那次核对后没变（结论是 fix/doubt 也算核过：人明确判断过了）
 * 黄 stale     = 核过，但之后内容被改过 —— 签字页会标「核对后被修改」
 * 灰 unverified = 从来没有被任何人核过
 */
export function triState(s) {
  const total = Number(s && s.total) || 0
  const stale = Number(s && s.stale) || 0
  const done = Number(s && s.done) || 0
  return {
    verified: Math.max(0, done - stale),
    stale,
    unverified: Math.max(0, total - done),
    total,
  }
}

/**
 * 批量核对：给指定编号一次打上同一结论。
 *
 * 设计上的克制：
 *   - 必须显式给出 ids（不提供「全部未核一键通过」——那等于把签字变成形式）
 *   - 每条仍然调用 checkItem，逐条写追加记录（可审计，不覆盖任何东西）
 *   - 任何一条失败都如实回报，不静默跳过
 *
 * @param {{case:string, kind:string, ids:string[], result:string, by:string, note?:string}} args
 */
export function checkMany({ case: caseDirRaw, kind, ids, result, by = '', note = '' } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const list = Array.isArray(ids) ? ids.map((x) => String(x).trim()).filter(Boolean) : []
  if (!list.length) throw new Error('要批量核对哪几条？请给出编号（如 ["F1","F2"]）——不提供「全部通过」')
  if (list.length > 200) throw new Error(`一次最多 200 条（收到 ${list.length} 条）：太多了就不是逐条核对了`)

  const done = []
  const failed = []
  for (const id of list) {
    try {
      const r = checkItem({ case: dir, kind, id, result, by, note })
      done.push(id)
      void r
    } catch (e) {
      failed.push({ id, error: String((e && e.message) || e) })
    }
  }
  return {
    ok: failed.length === 0,
    kind,
    result,
    done,
    failed,
    count: done.length,
    summary:
      `批量标为「${RESULTS[result] ? RESULTS[result].label : result}」：成功 ${done.length} 条` +
      (failed.length ? `，失败 ${failed.length} 条（${failed.map((f) => f.id).join('、')}）` : ''),
  }
}

function fileDigest(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch (e) {
    return null
  }
}

/**
 * 生成签字页（Markdown）。
 * 会把「仍未核对」「需修改」「有疑问」「核对后被修改」全部写在纸面上——
 * 允许签，但不许让签字页看起来比实际更干净。
 */
export function buildSignoff({ case: caseDirRaw, signer = '', outDir } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const { cp, c } = loadCase(dir)
  const st = checkStatus({ case: dir })
  const who = String(signer || '').trim()
  if (!who) throw new Error('签字人要写（signer）：签字页上必须有名字')

  const out = String(outDir || path.join(dir, 'out'))
  fs.mkdirSync(out, { recursive: true })
  const file = path.join(out, `核对签字_${(c.caseId || '').slice(0, 15) || 'case'}.md`)

  const digests = [
    ['facts.jsonl', cp.facts],
    ['findings.jsonl', cp.findings],
    ['materials.json', cp.materials],
    ['checkoff.jsonl', checkoffPath(cp)],
  ].map(([name, p]) => ({ name, sha256: fileDigest(p) || '（不存在）' }))

  const L = []
  L.push(`# 核对签字单`, '')
  L.push(`- 案件：${c.title}（${c.caseId || '—'}）`)
  L.push(`- 案型：${c.caseType === 'contract' ? '合同审核' : '诉讼/争议'}`)
  L.push(`- 签字人：**${who}**`)
  L.push(`- 签字时间：${nowIso()}`)
  L.push('')
  L.push('## 一、核对结论', '')
  L.push(`- 台账条目总数：**${st.total}**`)
  L.push(`- 已核对：**${st.done}**`)
  L.push(`- 未核对：**${st.pending}**${st.pending ? '　← 这些还没有人看过' : ''}`)
  L.push(`- 需修改：**${st.fix}**；有疑问：**${st.doubt}**`)
  if (st.stale) L.push(`- ⚠️ 核对后被修改：**${st.stale}** 条（核对时的内容指纹与现在不一致）`)
  L.push('')
  if (st.pending || st.fix || st.doubt || st.stale) {
    L.push('> 本单**不是**「全部无误」的证明：上表中未核对、需修改、有疑问、核对后被修改的条目，签字人已知悉并承接相应风险。', '')
  } else {
    L.push('> 本单所附台账已逐条核对，未发现待改或存疑项。', '')
  }
  for (const kind of Object.keys(CHECK_KINDS)) {
    const stat = st.kinds[kind]
    const items = st.items.filter((x) => x.kind === kind)
    L.push(`## ${CHECK_KINDS[kind].label}（${stat.done}/${stat.total} 已核）`, '')
    if (!items.length) {
      L.push('（本号为空）', '')
      continue
    }
    L.push('| 编号 | 内容摘要 | 核对结论 | 核对人 | 时间 | 备注 |', '|---|---|---|---|---|---|')
    for (const it of items) {
      const res = it.result ? RESULTS[it.result].label + (it.changed ? '（核对后已改）' : '') : '**未核对**'
      const summary = String(it.text || '').replace(/\|/g, '/').slice(0, 40)
      L.push(
        `| ${it.id} | ${summary} | ${res} | ${it.by || '—'} | ${(it.at || '').slice(0, 16).replace('T', ' ') || '—'} | ${String(it.note || '').replace(/\|/g, '/').slice(0, 30) || '—'} |`
      )
    }
    L.push('')
  }
  L.push('## 附：文件指纹（SHA256）', '')
  L.push('| 文件 | SHA256 |', '|---|---|')
  for (const d of digests) L.push(`| ${d.name} | \`${d.sha256}\` |`)
  L.push('')
  L.push('---', '')
  L.push(`签字：**${who}**　　日期：${nowIso().slice(0, 10)}`, '')
  L.push('> 本单由 LawCase 依据核对台账生成。「已核对」表示有人逐条看过该条内容，不代表内容本身在法律上成立；法律判断仍由承办人负责。', '')

  const md = L.join('\n')
  fs.writeFileSync(file, md, 'utf8')
  const meta = {
    caseId: c.caseId,
    signer: who,
    at: nowIso(),
    stats: { total: st.total, done: st.done, pending: st.pending, fix: st.fix, doubt: st.doubt, stale: st.stale },
    digests,
    file,
  }
  fs.writeFileSync(path.join(out, 'signoff.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
  log(dir, 'signoff', { signer: who, done: st.done, total: st.total })

  return {
    ok: true,
    file,
    meta,
    summary:
      `已生成签字单 ${path.basename(file)}｜签字人 ${who}｜已核 ${st.done}/${st.total}` +
      (st.pending ? `｜未核 ${st.pending}` : '') +
      (st.fix ? `｜需修改 ${st.fix}` : '') +
      (st.doubt ? `｜有疑问 ${st.doubt}` : ''),
  }
}

import path from 'node:path'
import { casePaths, readJson, readJsonl, appendJsonl, nowIso, log } from './store.js'

export const SEVERITY = ['致命', '重大', '一般']

/** 攻击阶段禁止出现的「建议性措辞」。
 *  文档要求：只攻击，不给方案。给了方案，被攻击方就会照着改，
 *  攻击的独立性就没了——这是对抗复盘最容易退化成「互相提建议」的地方。 */
export const ADVICE_PATTERNS = [
  { re: /建议(?:补充|增加|修改|改为|采用|考虑|删除)/, why: '「建议补充/修改…」= 给方案' },
  { re: /应当(?:改|修改|补充|增加|删除|采用|调整)/, why: '「应当修改…」= 给方案' },
  { re: /可以考虑|可考虑/, why: '「可以考虑…」= 给方案' },
  { re: /推荐|不妨|最好(?:是)?(?:改|补|加)/, why: '推荐性措辞 = 给方案' },
  { re: /正确的做法是|更好的写法|应改为/, why: '直接给正确写法 = 给方案' },
]

export function detectAdvice(text) {
  const hits = []
  for (const p of ADVICE_PATTERNS) {
    const m = p.re.exec(text)
    if (m) hits.push({ match: m[0], why: p.why })
  }
  return hits
}

function replay(dir) {
  const cp = casePaths(dir)
  const rows = readJsonl(cp.review).filter((r) => !r.__broken)
  const rounds = new Map()
  for (const r of rows) {
    if (!r.round) continue
    if (!rounds.has(r.round)) {
      rounds.set(r.round, { round: r.round, subject: '', openedAt: null, attacks: new Map(), closed: false })
    }
    const R = rounds.get(r.round)
    if (r.type === 'open') {
      R.subject = r.subject || ''
      R.openedAt = r.at
    } else if (r.type === 'attack') {
      R.attacks.set(r.aid, { aid: r.aid, target: r.target, text: r.text, at: r.at, reply: null, verdict: null })
    } else if (r.type === 'reply') {
      const a = R.attacks.get(r.aid)
      if (a) a.reply = { text: r.text, at: r.at }
    } else if (r.type === 'verdict') {
      const a = R.attacks.get(r.aid)
      if (a) a.verdict = { severity: r.severity, note: r.note, at: r.at }
    } else if (r.type === 'close') {
      R.closed = true
    }
  }
  return [...rounds.values()].map((R) => {
    const list = [...R.attacks.values()]
    return {
      ...R,
      attacks: list,
      counts: {
        attacks: list.length,
        replied: list.filter((a) => a.reply).length,
        judged: list.filter((a) => a.verdict).length,
        fatal: list.filter((a) => a.verdict && a.verdict.severity === '致命').length,
      },
    }
  })
}

export function loadRounds(dir) {
  return replay(path.resolve(dir))
}

function mustRound(dir, round) {
  const R = replay(path.resolve(dir)).find((r) => r.round === String(round).toUpperCase())
  if (!R) throw new Error(`没有 ${round} 这一轮复盘（先 lc_review_open 开一轮）`)
  return R
}

export function openReview({ case: caseDirRaw, subject }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  if (!readJson(cp.caseJson, null)) throw new Error(`不是 LawCase 案件：${dir}`)
  const sub = String(subject || '').trim()
  if (!sub) throw new Error('复盘对象必填（针对哪条结论/哪份文书做对抗复盘）')
  const rounds = replay(dir)
  const next = 'R' + (rounds.length + 1)
  appendJsonl(cp.review, { type: 'open', round: next, subject: sub, at: nowIso() })
  log(dir, 'review-open', { round: next })
  return {
    ok: true, round: next, subject: sub,
    summary: `已开 ${next}｜复盘对象：${sub}｜现在进入第一回合：只攻击，不许给建议`,
  }
}

export function addAttack({ case: caseDirRaw, round, target, text }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const R = mustRound(dir, round)
  if (R.closed) throw new Error(`${R.round} 已归档，不能再追加攻击`)
  if (R.counts.judged > 0) throw new Error(`${R.round} 已经进入裁定，不能再追加攻击（追加会把已裁定的结论基础改掉）`)
  const t = String(text || '').trim()
  if (t.length < 10) throw new Error('攻击点太短（<10 字）：写清「哪一处、凭什么站不住」才有对抗价值')
  const advice = detectAdvice(t)
  if (advice.length) {
    throw new Error(
      `攻击阶段不许给建议（命中「${advice[0].match}」：${advice[0].why}）。` +
        `这里只说「哪里站不住、为什么」，改法留到被攻击方回应之后。`
    )
  }
  const aid = 'A' + (R.counts.attacks + 1)
  appendJsonl(cp.review, { type: 'attack', round: R.round, aid, target: String(target || '').trim(), text: t, at: nowIso() })
  log(dir, 'review-attack', { round: R.round, aid })
  return {
    ok: true, round: R.round, aid,
    summary: `已登记攻击点 ${R.round}/${aid}${target ? '（针对 ' + target + '）' : ''}｜当前 ${R.counts.attacks + 1} 条，已回应 ${R.counts.replied} 条`,
  }
}

export function addReply({ case: caseDirRaw, round, aid, text }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const R = mustRound(dir, round)
  const a = R.attacks.find((x) => x.aid === String(aid).toUpperCase())
  if (!a) throw new Error(`${R.round} 里没有攻击点 ${aid}`)
  if (a.reply) throw new Error(`${a.aid} 已经回应过了，不能覆盖（回应是留痕，改了就没法复核）`)
  const t = String(text || '').trim()
  if (t.length < 5) throw new Error('回应太短（<5 字）：要么承认站不住，要么说清凭什么仍成立')
  appendJsonl(cp.review, { type: 'reply', round: R.round, aid: a.aid, text: t, at: nowIso() })
  log(dir, 'review-reply', { round: R.round, aid: a.aid })
  return {
    ok: true, round: R.round, aid: a.aid,
    summary: `已回应 ${R.round}/${a.aid}｜本轮已回应 ${R.counts.replied + 1}/${R.counts.attacks} 条`,
  }
}

export function addVerdict({ case: caseDirRaw, round, aid, severity, note }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const R = mustRound(dir, round)
  const a = R.attacks.find((x) => x.aid === String(aid).toUpperCase())
  if (!a) throw new Error(`${R.round} 里没有攻击点 ${aid}`)
  if (!a.reply) throw new Error(`${a.aid} 还没回应，不能裁定——先回应再裁，否则等于没人辩护就定罪`)
  if (a.verdict) throw new Error(`${a.aid} 已经裁定过了（${a.verdict.severity}），不能改判`)
  const sev = String(severity || '').trim()
  if (!SEVERITY.includes(sev)) throw new Error(`裁定级别只能是：${SEVERITY.join(' / ')}`)
  const n = String(note || '').trim()
  if (sev !== '一般' && n.length < 5) throw new Error('判为「致命/重大」必须写裁定理由')
  appendJsonl(cp.review, { type: 'verdict', round: R.round, aid: a.aid, severity: sev, note: n || undefined, at: nowIso() })
  log(dir, 'review-verdict', { round: R.round, aid: a.aid, severity: sev })
  const left = R.counts.attacks - R.counts.judged - 1
  return {
    ok: true, round: R.round, aid: a.aid, severity: sev,
    summary: `${R.round}/${a.aid} 裁定为「${sev}」${left > 0 ? `｜还剩 ${left} 条待裁定` : '｜本轮已全部裁定'}`,
  }
}

/** 未闭环的致命项：被裁为致命、但结论没被推翻也没标注处理方式 */
export function unresolvedFatal(dir) {
  const out = []
  for (const R of replay(path.resolve(dir))) {
    for (const a of R.attacks) {
      if (a.verdict && a.verdict.severity === '致命' && !a.verdict.note?.includes('已处理')) {
        out.push({ round: R.round, aid: a.aid, target: a.target, note: a.verdict.note })
      }
    }
  }
  return out
}

export function listReview({ case: caseDirRaw, round }) {
  const dir = path.resolve(caseDirRaw)
  const all = replay(dir)
  const rounds = round ? all.filter((r) => r.round === String(round).toUpperCase()) : all
  const fatal = unresolvedFatal(dir)
  return {
    ok: true, roundCount: all.length, rounds,
    unresolvedFatal: fatal,
    summary: all.length
      ? `复盘 ${all.length} 轮｜` +
        all.map((r) => `${r.round} ${r.counts.attacks}攻/${r.counts.replied}应/${r.counts.judged}裁`).join('，') +
        (fatal.length ? `｜未闭环致命 ${fatal.length} 条` : '')
      : '还没有任何复盘轮次',
  }
}

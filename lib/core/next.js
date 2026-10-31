import fs from 'node:fs'
import path from 'node:path'
import { readJson, readJsonl, casePaths } from './store.js'
import { checkStatus } from './checkoff.js'
import { lawTrace } from './lawtrace.js'
import { contractCandidates } from './clause.js'

/**
 * 状态驱动的「下一步该做什么」。
 *
 * 流水线只能跑机械段（建案/扫材料/解析）；抽事实、出结论、定版本要人判断。
 * 所以真正的问题不是「一次跑完」，而是「每一步都知道该做什么、怎么调」。
 * 这个函数读整个案件状态，找出当前卡点，给出可直接复制的调用。
 */
/**
 * 索引是不是旧逻辑生成的。
 *
 * 判据：条款编号里**同时**存在纯数字（1/2/3）和「第X条」两种形态。
 * 正常合同只会是一种（正文用「第X条」，或自动编号合同全用数字）。
 * 混在一起说明前言里的编号列表被误切成条款了——那是 2.47 之前的行为。
 *
 * 为什么要主动提示而不是等用户发现：这类索引的症状是「同一条款出现两次、
 * 意见和草稿挂不上」，表现出来却像"AI 没审出东西"，极难自查（2026-11-01 实测）。
 */
function looksStaleIndex(clauseFiles) {
  const files = Array.isArray(clauseFiles) ? clauseFiles : []
  for (const f of files) {
    const list = (f && Array.isArray(f.clauses) ? f.clauses : []).map((c) => String((c && c.no) || '').replace(/\s+/g, ''))
    if (!list.length) continue
    const hasCn = list.some((x) => /第[零一二三四五六七八九十百]+条/.test(x))
    const hasNum = list.some((x) => /^\d{1,3}$/.test(x))
    if (hasCn && hasNum) return true
  }
  return false
}

export function nextStep({ case: caseDirRaw }) {
  const dir = path.resolve(String(caseDirRaw))
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  if (!c) throw new Error(`${dir} 不是 LawCase 案件`)

  const mats = readJson(cp.materials, null)
  const files = (mats && mats.files) || []
  const groups = (mats && mats.groups) || []
  // 事实按 id 合并：修正（lc_fact_amend）是追加覆盖，直接读原始行会把同一条算两遍
  // （某案原始 178 行，真实只有 82 条事实）
  const factById = new Map()
  for (const f of readJsonl(cp.facts)) {
    if (f.__broken || !f.id) continue
    factById.set(f.id, { ...(factById.get(f.id) || {}), ...f })
  }
  const facts = [...factById.values()].filter((f) => !f.revoked && !f.__revoked)
  const knownIds = new Set(facts.map((f) => f.id))
  const findings = readJsonl(cp.findings)
  const proc = c.proc || []
  const clausesRaw = readJson(cp.clauses, null)
  const clauseFiles = (clausesRaw && clausesRaw.files) || []
  const clauseCount = clauseFiles.reduce((n, f) => n + ((f && f.clauses) || []).length, 0)
  const notes = readJsonl(cp.notes || path.join(cp.state, 'notes.jsonl'))
  const review = readJsonl(cp.review || path.join(cp.state, 'review.jsonl'))
  const isContract = c.caseType === 'contract'

  // 核对台账（唯一口径）：事实/结论/材料三本的逐条核对进度
  let factCheck = { total: 0, done: 0, pending: 0, fix: 0, doubt: 0, stale: 0 }
  let allCheck = { total: 0, done: 0, pending: 0 }
  try {
    const ck = checkStatus({ case: dir })
    factCheck = (ck.kinds && ck.kinds.fact) || factCheck
    allCheck = { total: ck.total, done: ck.done, pending: ck.pending }
  } catch (e) {}

  const cand = []
  const push = (priority, stuck, action, tool, args, why) =>
    cand.push({ priority, stuck, action, tool, args, why })

  const rel = (p) => (path.isAbsolute(p) ? p : path.join(dir, p))
  const outDir = path.join(dir, 'out')
  const outFiles = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => !f.startsWith('~$')) : []
  const hasReport = outFiles.some((f) => /意见|报告/.test(f))
  const hasRedline = outFiles.some((f) => /修订|redline/.test(f))
  const parsedCache = path.join(cp.state, 'cache', 'parse')
  const parsedCount = fs.existsSync(parsedCache) ? fs.readdirSync(parsedCache).filter((f) => f.endsWith('.json')).length : 0

  // ---- 材料层 ----
  const knownWork = clauseCount > 0 || notes.length > 0 || findings.length > 0 || facts.length > 0
  if (!isContract && !(c.materialsDirs || []).length && !files.length && !knownWork) {
    push(1, '没有材料源', '把卷宗目录告诉插件，之后才能扫材料', 'lc_material_scan', { case: dir, source: '<卷宗目录绝对路径>' }, '没有材料就没有后面任何一步')
  } else if (files.length && parsedCount === 0) {
    push(1, `材料 ${files.length} 份但一份没解析`, '批量解析，扫描件会自动走 OCR', 'lc_material_parse_all', { case: dir }, '解析出文本才能核对事实出处')
  } else if (files.length > parsedCount) {
    push(2, `还有 ${files.length - parsedCount} 份没解析`, '继续批量解析', 'lc_material_parse_all', { case: dir }, '已解析的会走缓存，不重复干活')
  }

  const undecided = groups.filter((g) => !g.decision)
  if (undecided.length) {
    push(1, `有 ${undecided.length} 组版本待定`, `指定哪份为准（如 ${undecided[0].members.map((m) => m.mid).join(' / ')}）`, 'lc_material_decide', { case: dir, group: undecided[0].members[0].mid, accept: '<以哪份为准的 mid>' }, '不先定版本，后面引用的出处可能指向旧稿')
  }

  // ---- 工序层（仅诉讼/争议案）----
  // 合同审核案没有「工序」页（用户 2026-10-27 明确要求）：合同审核的推进单位是"条款"，
  // 用条款状态 + 意见 + 预检 + 验收就够了。这里若不跳过，下一步会一直提示
  // "把要做的事拆成工序"，而界面上根本没有那个页面——用户会照做一遍再发现无处可去。
  if (!isContract) {
    if (!proc.length) {
      push(2, '还没有工序表', '把要做的事拆成工序，每道写清验收标准', 'lc_proc_plan', { case: dir, processes: [{ name: '<工序名>', acceptance: '<怎么算做完>' }] }, '没有验收标准的工序等于没做')
    } else {
      const doing = proc.find((p) => p.status === 'doing')
      const todo = proc.filter((p) => p.status === 'todo')
      if (doing) push(3, `工序 ${doing.id}「${doing.name}」进行中`, `做完后标记完成：${doing.id}`, 'lc_proc_update', { case: dir, id: doing.id, status: 'done' }, '不标记完成，进度台账就一直停在原地')
      else if (todo.length) push(3, `还有 ${todo.length} 道工序待做`, `开始第一道：${todo[0].id}「${todo[0].name}」`, 'lc_proc_update', { case: dir, id: todo[0].id, status: 'doing' }, '让进度台账反映真实状态')
    }
  }

  // ---- 合同审核线 ----
  if (isContract) {
    // 候选合同取自材料台账：能自动找的绝不让用户查路径。
    // 以前这里给的是 file: '<合同 docx 绝对路径>'，等于把机械劳动推给人。
    let cand = []
    try {
      cand = contractCandidates({ case: dir })
    } catch (e) {
      cand = []
    }
    // 审核范围的口径（用户 2026-11-01 明确）：**只索引了 A、B 就是只审 A、B**，
    // 没点索引的一律视为不审，不需要再逐个点「不索引」确认。
    // 所以「待决定」只在**一份都没索引**时才算问题；一旦索引过，剩下的安静放着即可。
    //
    // 「还没决定」的候选 = 既没索引、也没明确跳过、且文件还在。
    // 判据必须包含 skipped，否则卷宗里只要混进一份没有「第X条」的附件，
    // 这一步就永远完成不了（用户 2026-11-01 实测反馈：「按现在的规则始终走不完这一步」）。
    const undecided = cand.filter((x) => x.exists && !x.indexed && !x.skipped)
    const first = undecided[0] || null

    if (!clauseCount && !undecided.length) {
      push(
        1,
        '合同还没切条款',
        first ? `把材料里的《${first.name}》切成条款索引` : '按「第X条」把合同切成条款索引',
        'lc_clause_index',
        { case: dir, file: first ? first.mid : 'M1' },
        first
          ? `材料台账里已有这份合同（${first.mid}），直接按编号索引即可，不用查路径`
          : '不切条款，审核意见就落不到具体位置；材料台账为空时先扫材料'
      )
    } else if (!clauseCount) {
      // 索引已齐但一条都没切出来：这时候推「索引」没意义，要推「换一份 / 或明确跳过」
      push(
        1,
        '一份合同都没有切出条款',
        `确认这几份是不是都没有「第X条」；若不是，先索引《${first.name}》，否则标记不索引`,
        'lc_clause_index',
        { case: dir, file: first.mid },
        '切不出条款通常是扫描件或没有条款编号；确认不审的用 lc_clause_skip 收口，别让它一直挂着'
      )
    } else if (looksStaleIndex(clauseFiles)) {
      // 索引是旧逻辑生成的（前言编号被当成条款、或条号对不上正文）：
      // 这类索引会让「意见/草稿」挂到错的位置上——用户看到的就是
      // 「AI 审了但界面上什么都没有」。所以宁可直接提示重建。
      push(
        1,
        '条款索引可能是旧版本生成的（编号里混了前言列表）',
        '重新索引这份合同：会让条号与正文对齐',
        'lc_clause_index',
        { case: dir, file: (cand.find((x) => x.indexed) || {}).mid || 'M1' },
        '旧索引里同时存在「1、2、3」和「第一条」，同一条款会出现两次，意见/草稿会对不上'
      )
    } else if (!notes.length) {
      // 有 AI 草稿还没被采纳时，别再推「去登记意见」——那会让人以为要手写。
      // 该推的是「去采纳草稿」（用户 2026-11-01 实测：审完 21 条草稿，
      // 界面却告诉他"还没有意见"，等于把 AI 的活白干了）。
      let draftCount = 0
      try {
        const dd = readJson(path.join(cp.state, 'note-drafts.json'), null)
        draftCount = dd && Array.isArray(dd.drafts) ? dd.drafts.length : 0
      } catch (e) {
        draftCount = 0
      }
      if (draftCount) {
        push(
          2,
          `AI 已审出 ${draftCount} 条意见，但一条都没采纳`,
          '到「意见」页逐条确认：采纳的进台账，不同意的标「无需修改」并写理由',
          'lc_note_list',
          { case: dir },
          '草稿只有被采纳才进台账；不采纳也不会消失，会一直等着处理'
        )
      } else {
        push(2, `已索引 ${clauseCount} 条，还没有意见`, '逐条审核并登记意见（必须指到条款、给出可替换条文），也可以先点「AI 审核全部条款」', 'lc_note_add', { case: dir, clause: '第X条', issue: '<问题与后果>', fix: '<可直接替换的条文>' }, '空泛话术（进一步明确/酌情）会被拒收')
      }
    } else if (notes.every((n) => n.level === notes[0].level) && notes.length >= 3) {
      push(3, `${notes.length} 条意见全是「${notes[0].level}」`, '复核分级：真重大的和只是措辞的应分开', 'lc_note_list', { case: dir }, '全同档等于没分级')
    }
  }

  // ---- 事实层（诉讼线） ----
  if (!isContract) {
    if (!facts.length && parsedCount) {
      push(2, '材料已解析，事实台账空着', `逐条抽事实：从材料里找法律上有意义的句子，记下「材料编号 + 位置 + 原文引用」`, 'lc_fact_add', { case: dir, text: '<一句话一件事>', source: 'M1', locator: '第3段', quote: '<原文片段>' }, '没有事实台账，结论就没有支撑，五道验收的事实道必然红')
    } else if (facts.length) {
      // 复核口径只看 checkoff（逐条核对台账），那才是签字依据。
      // 以前这里读 f.confirmed，而 addFact 写的是 verified——字段名对不上，
      // 于是永远报「全部待复核」，是个假警报。
      const pendingCount = factCheck.total ? factCheck.pending : 0
      if (pendingCount) {
        push(3, `${pendingCount} 条事实还没人工核对`, `去「事实」页逐条点「已核」，或让我批量标：${facts.slice(0, 3).map((f) => f.id).join('、')}`, 'lc_checkoff', { case: dir }, '没核对的事实进不了签字单')
      }
      const broken = facts.filter((f) => f.issue === 'broken' || f.status === 'broken' || f.verified === 'broken')
      if (broken.length) push(1, `${broken.length} 条事实出处对不上`, `修出处或作废：${broken.slice(0, 3).map((f) => f.id).join('、')}`, 'lc_fact_amend', { case: dir, id: broken[0].id, reason: '<为什么改>' }, '出处失效的事实比没有事实更危险')
    }
  }

  // ---- 结论层 ----
  // 「能用的前提事实」= 存在的事实（核对状态是签字环节的事，不是出结论的门槛，
  // 否则会逼用户先把 154 条全点一遍才能写第一条结论，顺序反了）
  const usableFacts = facts
  if (!findings.length) {
    if (isContract && notes.length >= 3 && !hasReport) {
      push(4, '意见够了，该出报告', '生成合同审核意见表', 'lc_contract_report', { case: dir }, '意见留在台账里没人看')
    } else if (isContract && notes.length >= 3 && hasReport && !hasRedline) {
      push(4, '报告有了，该出修订版合同', '把意见落回合同文本（红色删除线 + 红色下划线）', 'lc_contract_revise', { case: dir }, '律师要能直接看到改哪里')
    } else if (!isContract && usableFacts.length >= 2) {
      push(4, '有事实但还没有结论', '基于事实出结论，必须引用事实编号', 'lc_finding_add', { case: dir, text: '<谁对谁、基于什么、得出什么>', factRefs: usableFacts.slice(0, 2).map((f) => f.id) }, '结论必须能追到事实，否则就是凭空判断')
    } else if (!isContract && facts.length && !usableFacts.length) {
      push(4, '事实全部未复核', '先复核事实，再出结论', 'lc_fact_list', { case: dir, pendingOnly: true }, '拿未经复核的事实出结论，等于把校验环节跳过')
    }
  } else {
    // 结论引用了不存在/已作废的事实
    const badRef = findings.filter((f) => (f.factRefs || []).some((r) => !knownIds.has(r)))
    if (badRef.length) push(0, `${badRef.length} 条结论引用了已作废或不存在的事实`, `修结论的事实引用：${badRef.map((f) => f.id).join('、')}`, 'lc_finding_list', { case: dir }, '被引用的事实都作废了，结论悬空')
  }

  // ---- 对抗复盘 ----
  const rounds = new Set(review.filter((e) => e.round).map((e) => e.round))
  if (findings.length && !rounds.size) {
    push(5, '结论还没被攻击过', '开一轮对抗复盘：先只攻击，不给建议', 'lc_review_open', { case: dir, subject: `${findings[0].id} ${(findings[0].text || '').slice(0, 20)}` }, '没人攻击过的结论，自己看不出问题')
  }

  // ---- 验收与交付 ----
  // 未裁定 = 有攻击但没对应裁定的编号数。
  // 不能用「攻击数 - 裁定数」：同一点可能被裁定多次，减法会算出负数（踩过，-3），
  // 负数又让后面的 !reviewUnclosed 判断全部失效。
  const attackIds = new Set(review.filter((e) => e.type === 'attack').map((e) => e.aid).filter(Boolean))
  const verdictIds = new Set(review.filter((e) => e.type === 'verdict').map((e) => e.aid).filter(Boolean))
  const reviewUnclosed = [...attackIds].filter((a) => !verdictIds.has(a)).length
  if (reviewUnclosed > 0) {
    push(1, `有 ${reviewUnclosed} 个攻击点没裁定`, '逐条裁定（致命/重大/一般）', 'lc_review_verdict', { case: dir, round: [...rounds][0] || 'R1', aid: '<攻击点编号>', severity: '<致命/重大/一般>' }, '没裁定的攻击点等于悬案')
  }

  // ---- 法条溯源（诉讼线：结论与验收之间） ----
  // 结论都写了，但引的法条没核过——这一步不能跳：条号写错、没原文、来源是手打的，
  // 交付后对方一问就答不上来。
  let traceStats = null
  if (!isContract && findings.length) {
    try {
      const tr = lawTrace({ case: dir })
      traceStats = tr.stats
      if (tr.items.some((x) => x.level !== 'pass')) {
        const bad = tr.items.filter((x) => x.level !== 'pass')
        push(
          5,
          `${bad.length} 条结论的法条引证有问题`,
          '去「法条」页看逐条溯源：条号是否存在、有没有原文、来源是否权威',
          'lc_law_trace',
          { case: dir },
          '条号或原文对不上，等于结论没有依据'
        )
      } else if (tr.items.length && !tr.items.every((x) => x.level === 'pass')) {
        // 理论上跑不到，留个兜底
      }
    } catch (e) {}
  }

  // 核对未完成：不是硬门槛（允许带未核项出交付包），但必须让人知道签字单会写明
  if (allCheck.total && allCheck.pending > 0) {
    push(
      6,
      `还有 ${allCheck.pending} 条台账未核对`,
      '去对应页逐条点「✓ 已核」（事实/结论/材料都要）；未核完也能出签字单，但签字单会写明未核条数',
      'lc_checkoff',
      { case: dir },
      '核对记录是签字单的依据，未核的条目在签字单上会标注'
    )
  }

  const readyForCheck = (isContract ? notes.length : findings.length) > 0
  // 读过上次验收结果再决定推什么。
  // 用户 2026-11-01 实测：交付包已经「验收 pass」，底部还在催「跑五道验收」——
  // 因为这里原来无条件推，从不看验收跑没跑过。
  let lastVerify = null
  try {
    lastVerify = readJson(path.join(cp.state, 'last-verify.json'), null)
  } catch (e) {
    lastVerify = null
  }
  const hasDelivery = (() => {
    try {
      return fs.readdirSync(dir).some((n) => /^交付包_/.test(n))
    } catch (e) {
      return false
    }
  })()
  // 兜底：交付包里带 delivery.json，里面的 verdict 就是当时的验收结论。
  // 为什么需要：last-verify.json 是 2.53 之后才写的，之前的案件没有；
  // 但它们**已经打包交付过**，再催"跑验收"就是重复劳动（用户 2026-11-01 实测）。
  let deliveryVerdict = null
  if (hasDelivery) {
    try {
      const dirs = fs.readdirSync(dir).filter((n) => /^交付包_/.test(n)).sort()
      const latest = dirs[dirs.length - 1]
      const dj = readJson(path.join(dir, latest, 'delivery.json'), null)
      deliveryVerdict = dj && dj.verdict ? String(dj.verdict) : null
    } catch (e) {
      deliveryVerdict = null
    }
  }
  const verifiedPass = Boolean(
    (lastVerify && lastVerify.verdict === 'pass') || deliveryVerdict === 'pass'
  )

  if (readyForCheck && !reviewUnclosed && !verifiedPass) {
    push(
      6,
      lastVerify
        ? `上次验收：${lastVerify.summary || '未通过'}`
        : '可以跑五道验收了',
      '检查事实/法条/逻辑/格式/保密',
      'lc_case_verify',
      { case: dir },
      '交付前必须过五道'
    )
  }
  if (readyForCheck && !reviewUnclosed && !hasDelivery) {
    push(
      7,
      verifiedPass ? '验收已通过，可以打交付包了' : '验收通过后打交付包',
      '把产物打包成一个可外发的目录',
      'lc_deliver',
      { case: dir },
      '散落在 out/ 里容易漏带'
    )
  }

  cand.sort((a, b) => a.priority - b.priority)
  const top = cand[0] || null

  return {
    ok: true,
    case: dir,
    caseId: c.caseId,
    caseType: isContract ? 'contract' : 'litigation',
    status: c.status,
    state: {
      materials: files.length,
      parsed: parsedCount,
      versionGroups: groups.length,
      undecided: undecided.length,
      proc: { total: proc.length, done: proc.filter((p) => p.status === 'done').length },
      facts: facts.length,
      // 核对口径统一走 checkoff：factsPending 就是「还没人核对过的事实条数」
      factsPending: factCheck.pending,
      factChecked: factCheck.done,
      factCheckTotal: factCheck.total,
      checkoff: allCheck,
      findings: findings.length,
      clauses: clauseCount,
      notes: notes.length,
      reviewRounds: rounds.size,
    },
    next: top,
    alsoTodo: cand.slice(1, 4),
    summary: top
      ? `卡在：${top.stuck}｜下一步：${top.tool} — ${top.action}`
      : '这条线已经走到头了：所有检查项都齐了，剩下的是人工判断',
  }
}

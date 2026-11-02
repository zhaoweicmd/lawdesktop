// 条款审核状态机 + 采纳/丢弃闭环 + 审计。
//
// 钉住的核心是「审过没有」这件事必须能从台账上读出来：
//   · 丢弃草稿 → 判定进 rulings.jsonl，且草稿消失（不能只从界面移除）
//   · 采纳草稿 → 意见进 notes.jsonl + revision 判定 + 草稿消失
//   · 同一条既判「无需修改」又登记意见 → 必须报「结论打架」，不许静默挑一个
//   · AI 审核的模型/口径/时间/指纹要能追溯

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writeZip } from '../lib/core/zipwrite.js'
import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { indexClauses, loadRulings, loadNotes, validateDrafts } from '../lib/core/clause.js'
import { casePaths } from '../lib/core/store.js'
import { setReviewConfig } from '../lib/core/contractcfg.js'
import { clauseStateMachine, CLAUSE_STATES } from '../lib/core/clausestate.js'
import { runAiReview, loadAiAudit, loadDraftsDetail } from '../lib/core/aireview.js'

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lawcase-state-${tag}-`))
}

function makeDocx(file, paras) {
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paras.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('') +
    '</w:body></w:document>'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: doc },
  ]))
  return file
}

const P1 = '第一条 本合同项下服务费为人民币十万元，甲方应于合同签订后三日内一次性支付全部款项。'
const P2 = '第二条 乙方应于甲方付款后交付成果，交付标准由双方另行确定。'
const P3 = '第三条 任何一方违约的，应向对方赔偿因此造成的全部损失。'

function contractCase(tag = 'c') {
  const dir = tmpDir(tag)
  const mat = tmpDir(tag + '-mat')
  newCase({ dir, title: '状态机测试合同', caseType: 'contract', cause: '服务合同' })
  makeDocx(path.join(mat, '服务合同.docx'), [P1, P2, P3])
  scanMaterials({ case: dir, source: mat })
  indexClauses({ case: dir, file: '服务合同.docx' })
  return { dir, file: '服务合同.docx' }
}

const dm = (provider = 'fake', model = 'm1') => ({ currentSelection: () => ({ provider, model }) })

function fakeLlm(output) {
  return {
    listProviders: () => [{ id: 'fake', name: '假模型' }],
    async listModels() { return [{ id: 'm1', name: '模型一' }] },
    stream() {
      const text = output()
      return (async function* () {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

const out = () =>
  JSON.stringify({
    issues: [
      {
        clause: '第二条',
        severity: 'high',
        title: '交付标准未定',
        detail: '交付标准由双方另行确定，乙方交付后甲方可以标准未定为由拒收，服务边界完全不确定。',
        quote: '交付标准由双方另行确定',
        suggestion: '交付标准以本合同附件一《服务内容与交付标准》为准，附件未约定的按行业通用标准执行。',
      },
    ],
    skipped: [{ clause: '第三条', why: '赔偿范围表述完整，无需修改' }],
  })

/** 走一遍真实的 AI 审核，得到草稿 */
async function review(dir, file) {
  const r = await runAiReview({ case: dir, file, llm: fakeLlm(out), defaultModel: dm(), sessionId: '', pkgRoot: dir })
  assert.equal(r.ok, true, r.message)
  return r
}

// ============================================================================
// 状态机
// ============================================================================

test('状态机：没审核过时所有条款都是「待审」', () => {
  const { dir, file } = contractCase('fresh')
  const sm = clauseStateMachine({ case: dir, file })
  assert.equal(sm.total, 3)
  assert.equal(sm.counts.pending, 3)
  assert.equal(sm.counts.noted, 0)
  assert.match(sm.summary, /待审 3/)
})

test('状态机：审核过后，有草的条款变成「有 AI 草稿待处理」', async () => {
  const { dir, file } = contractCase('draft')
  await review(dir, file)
  const sm = clauseStateMachine({ case: dir, file })
  assert.equal(sm.counts.draft, 1, '只有第二条有草稿')
  assert.equal(sm.counts.pending, 2)
  const it = sm.items.find((x) => x.clause === '第二条')
  assert.equal(it.state, 'draft')
  assert.equal(it.stateLabel, CLAUSE_STATES.draft.label)
  assert.ok(it.draft, '要带出草稿摘要')
  assert.equal(it.draft.quoteOk, true)
})

test('状态机：模型判定「无需修改」的条款进 skipped，不算待审但也不算已登记', async () => {
  const { dir, file } = contractCase('skipped')
  const r = await review(dir, file)
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].clause, '第三条')
  // skipped 只是「模型建议无需修改」，还没人采纳成判定 → 仍是待审
  const sm = clauseStateMachine({ case: dir, file })
  assert.equal(sm.items.find((x) => x.clause === '第三条').state, 'pending')
})

// ============================================================================
// 丢弃 = 无需修改
// ============================================================================

test('丢弃草稿：判定落 rulings.jsonl，草稿消失，状态变「无需修改」', async () => {
  const { dir, file } = contractCase('discard')
  await review(dir, file)
  assert.equal(loadDraftsDetail({ case: dir }).count, 1)

  // 直接走 core：写入判定 + 清草稿（API 层是同一组合）
  const { ruleClause, clearDrafts } = await import('../lib/core/clause.js')
  ruleClause({ case: dir, file, clause: '第二条', kind: 'norevision', reason: '交付标准另附技术协议，无需改合同', by: '张律师' })
  clearDrafts({ case: dir, clause: '第二条' })

  assert.equal(loadDraftsDetail({ case: dir }).count, 0, '草稿要被移除，否则下次审核又捡回来')
  const rulings = loadRulings({ case: dir })
  assert.equal(rulings.length, 1)
  assert.equal(rulings[0].kind, 'norevision')
  assert.match(rulings[0].reason, /技术协议/)

  const sm = clauseStateMachine({ case: dir, file })
  const it = sm.items.find((x) => x.clause === '第二条')
  assert.equal(it.state, 'norevision')
  assert.equal(it.ruling.by, '张律师')
})

test('丢弃：理由可以留空（用户 2026-10-26 明确要求不用填）', async () => {
  const { dir, file } = contractCase('discardnoreason')
  await review(dir, file)
  const { ruleClause, loadRulings } = await import('../lib/core/clause.js')
  const r = ruleClause({ case: dir, file, clause: '第二条', kind: 'norevision', reason: '' })
  assert.equal(r.ok, true, '不给理由也要能丢弃')
  assert.equal(loadRulings({ case: dir }).length, 1, '留空也要留痕')
})

// ============================================================================
// 采纳 = 需修改
// ============================================================================

test('采纳草稿：意见进 notes.jsonl，判定进 rulings.jsonl，草稿消失', async () => {
  const { dir, file } = contractCase('adopt')
  const r = await review(dir, file)
  const d = r.drafts[0]

  const { addNote, ruleClause, clearDrafts } = await import('../lib/core/clause.js')
  const added = addNote({
    case: dir,
    file,
    clause: d.clause,
    level: d.level,
    issue: d.issue,
    fix: d.fix,
    quote: d.quote,
  })
  ruleClause({ case: dir, file, clause: d.clause, kind: 'revision', reason: '按 AI 草稿采纳' })
  clearDrafts({ case: dir, clause: d.clause })

  const notes = loadNotes(casePaths(dir))
  assert.equal(notes.length, 1)
  assert.equal(notes[0].clause, '第二条')
  assert.match(notes[0].fix, /附件一/)

  const rulings = loadRulings({ case: dir })
  assert.equal(rulings[0].kind, 'revision')

  const sm = clauseStateMachine({ case: dir, file })
  const it = sm.items.find((x) => x.clause === '第二条')
  assert.equal(it.state, 'noted')
  assert.equal(it.noteCount, 1)
})

test('采纳：人改过的措辞进台账（不是原始草稿）', async () => {
  const { dir, file } = contractCase('adoptedited')
  const r = await review(dir, file)
  const d = r.drafts[0]
  const { addNote } = await import('../lib/core/clause.js')
  addNote({
    case: dir,
    file,
    clause: d.clause,
    level: d.level,
    issue: d.issue + '（律师补充：另需关注附件是否签署。）',
    fix: '交付标准以附件一为准；附件一须经双方签字盖章后方生效。',
    quote: d.quote,
  })
  const notes = loadNotes(casePaths(dir))
  assert.match(notes[0].issue, /律师补充/)
  assert.match(notes[0].fix, /签字盖章/)
})

// ============================================================================
// 结论打架
// ============================================================================

test('状态机：同一条既判「无需修改」又登记意见 → 显式报冲突，不静默挑一个', async () => {
  const { dir, file } = contractCase('conflict')
  const { addNote, ruleClause } = await import('../lib/core/clause.js')
  ruleClause({ case: dir, file, clause: '第二条', kind: 'norevision', reason: '这条不用改，标准另附' })
  addNote({
    case: dir,
    file,
    clause: '第二条',
    level: '建议修改',
    issue: '交付标准未写清，乙方交付后甲方可能以标准未定为由拒收。',
    fix: '交付标准以本合同附件一《服务内容与交付标准》为准，附件未约定的按行业通用标准执行。',
  })

  const sm = clauseStateMachine({ case: dir, file })
  assert.equal(sm.conflicts.length, 1)
  const it = sm.items.find((x) => x.clause === '第二条')
  assert.ok(it.conflicts.length >= 1)
  assert.match(it.conflicts.join('；'), /打架|打架|矛盾|打架|作废/)
  assert.match(sm.summary, /结论打架/)
})

test('状态机：不传 file 时用最后索引的那份合同', async () => {
  const { dir } = contractCase('defaultfile')
  const sm = clauseStateMachine({ case: dir })
  assert.equal(sm.ok, true)
  assert.equal(sm.file, '服务合同.docx')
})

test('状态机：不是案件目录要报错', () => {
  const dir = tmpDir('notcase')
  assert.throws(() => clauseStateMachine({ case: dir }), /不是 LawCase 案件/)
})

// ============================================================================
// 审计可追溯
// ============================================================================

test('审计：每次审核记下模型、口径、合同指纹、时间与计数', async () => {
  const { dir, file } = contractCase('audit')
  setReviewConfig({ case: dir, stance: 'partyB', templateId: 'service', instructions: '重点看交付与违约' })
  await review(dir, file)

  const a = loadAiAudit({ case: dir })
  assert.equal(a.count, 1)
  const rec = a.items[0]
  assert.equal(rec.status, 'ok')
  assert.equal(rec.model.provider, 'fake')
  assert.equal(rec.model.model, 'm1')
  assert.equal(rec.stance, 'partyB')
  assert.equal(rec.templateId, 'service')
  assert.match(rec.instructions, /重点看交付/)
  assert.ok(rec.contract.sha256, '要有合同指纹')
  assert.ok(rec.configFingerprint, '要有口径指纹')
  assert.ok(rec.at && rec.finishedAt)
  assert.ok(rec.counts && typeof rec.counts.ok === 'number')
  assert.equal(rec.purpose, 'contract-review')
})

test('审计：换口径再审，口径指纹必须跟着变', async () => {
  const { dir, file } = contractCase('auditcfg')
  setReviewConfig({ case: dir, stance: 'partyA', templateId: 'general' })
  await review(dir, file)
  setReviewConfig({ case: dir, stance: 'partyB', templateId: 'service' })
  await review(dir, file)

  const a = loadAiAudit({ case: dir })
  assert.equal(a.count, 2)
  const [latest, older] = a.items
  assert.notEqual(latest.configFingerprint, older.configFingerprint, '换口径后指纹必须不同')
  assert.equal(latest.stance, 'partyB')
  assert.equal(older.stance, 'partyA')
})

test('审计：失败的那次也留痕，且带错误码', async () => {
  const { dir, file } = contractCase('auditfail')
  const bad = {
    listProviders: () => [{ id: 'fake', name: '假模型' }],
    async listModels() { return [{ id: 'm1', name: '模型一' }] },
    stream() {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      })()
    },
  }
  const r = await runAiReview({ case: dir, file, llm: bad, defaultModel: dm(), sessionId: '', pkgRoot: dir })
  assert.equal(r.ok, false)
  const a = loadAiAudit({ case: dir })
  assert.equal(a.items[0].status, 'failed')
  assert.equal(a.items[0].code, 'model/max-tokens')
})

test('草稿详情：带模型、口径、指纹，界面才能说清「这份草稿是谁审的」', async () => {
  const { dir, file } = contractCase('detail')
  setReviewConfig({ case: dir, stance: 'partyB', templateId: 'service' })
  await review(dir, file)
  const d = loadDraftsDetail({ case: dir })
  assert.ok(d.model.label)
  assert.match(d.config.brief, /乙方/)
  assert.ok(d.contract.sha256)
  assert.ok(d.reviewId)
  assert.match(d.summary, /AI 草稿 1 条/)
})

test('validateDrafts 与 AI 校验对同一条款给出一致结论（标准不漂移）', async () => {
  const { dir, file } = contractCase('consistency')
  const r = await review(dir, file)
  const d = r.drafts[0]
  // 把 AI 草稿原样交给老的 validateDrafts：它也必须判 ok
  const v = validateDrafts({
    case: dir,
    file,
    drafts: [{ clause: d.clause, level: d.level, issue: d.issue, fix: d.fix, quote: d.quote, basis: '' }],
  })
  assert.equal(v.drafts[0].ok, true, '同一份草稿两套校验不能一个过一个不过：' + JSON.stringify(v.drafts[0].problems))
})

// ============================================================================
// 「无需修改」理由不得是问题描述（把风险条款放行 = 最严重的误判）
// ============================================================================

test('丢弃：理由若在描述风险（未约定/失衡/缺乏…）必须拒收', async () => {
  const { dir, file } = contractCase('riskreason')
  const { ruleClause } = await import('../lib/core/clause.js')
  // 这是真机里真实发生过的写法：拿 AI 的 issue（问题描述）当"无需修改"的理由
  const bad = '本条约定的居间服务内容仅为推荐实习生，但没有约定乙方应推荐的人数、推荐时限，与第10条刚性付款义务形成单向失衡。'
  assert.throws(() => ruleClause({ case: dir, file, clause: '第二条', kind: 'norevision', reason: bad }), /描述风险/)
})

test('丢弃：写清"为什么不用改"的理由要能通过', async () => {
  const { dir, file } = contractCase('okreason')
  const { ruleClause } = await import('../lib/core/clause.js')
  const r = ruleClause({
    case: dir,
    file,
    clause: '第二条',
    kind: 'norevision',
    reason: '该标准已在附件一《技术协议》明确约定，合同正文无需重复',
  })
  assert.equal(r.ok, true)
  assert.equal(r.ruling.kind, 'norevision')
})

test('作废判定：追加 __deleted 留痕，loadRulings 不再返回它，原始行保留', async () => {
  const { dir, file } = contractCase('revoke')
  const { ruleClause, loadRulings, loadAllRulings, revokeRuling } = await import('../lib/core/clause.js')
  ruleClause({ case: dir, file, clause: '第二条', kind: 'norevision', reason: '标准已在附件一约定，正文无需重复' })
  assert.equal(loadRulings({ case: dir }).length, 1)

  const r = revokeRuling({ case: dir, file, clause: '第二条', reason: '原判定写错了：这条其实有风险', by: '复核人' })
  assert.equal(r.ok, true)

  assert.equal(loadRulings({ case: dir }).length, 0, '作废后不能算数')
  const all = loadAllRulings({ case: dir })
  assert.equal(all.length, 2, '原始行与作废行都要留在文件里（可审计）')
  assert.equal(all[0].kind, 'norevision', '原始判定不能被删掉')
  assert.equal(all[1].__deleted, true)
  assert.equal(all[1].wasKind, 'norevision')
})

test('作废判定：没有原判定时报错；重复作废是幂等的', async () => {
  const { dir, file } = contractCase('revoke-edge')
  const { ruleClause, revokeRuling } = await import('../lib/core/clause.js')
  assert.throws(() => revokeRuling({ case: dir, file, clause: '第二条', reason: '没有原判定' }), /没有找到/)

  ruleClause({ case: dir, file, clause: '第二条', kind: 'norevision', reason: '标准已在附件一约定，正文无需重复' })
  revokeRuling({ case: dir, file, clause: '第二条', reason: '判定写错了' })
  const again = revokeRuling({ case: dir, file, clause: '第二条', reason: '再作废一次' })
  assert.equal(again.already, true, '重复作废应幂等，不该堆一堆 __deleted 行')
})

test('作废判定：作废后状态机回到「待审」', async () => {
  const { dir, file } = contractCase('revoke-state')
  const { ruleClause, revokeRuling } = await import('../lib/core/clause.js')
  ruleClause({ case: dir, file, clause: '第二条', kind: 'norevision', reason: '标准已在附件一约定，正文无需重复' })
  assert.equal(clauseStateMachine({ case: dir, file }).items.find((x) => x.clause === '第二条').state, 'norevision')
  revokeRuling({ case: dir, file, clause: '第二条', reason: '原判定把风险条款放行了' })
  assert.equal(clauseStateMachine({ case: dir, file }).items.find((x) => x.clause === '第二条').state, 'pending')
})

test('作废判定：作废后又新记的判定仍可再次作废（幂等不能挡住新记录）', async () => {
  const { dir, file } = contractCase('revoke-order')
  const { ruleClause, revokeRuling, loadRulings, loadAllRulings } = await import('../lib/core/clause.js')

  ruleClause({ case: dir, file, clause: '第二条', kind: 'norevision', reason: '' })
  revokeRuling({ case: dir, file, clause: '第二条', reason: '第一次判定写错了' })
  assert.equal(loadRulings({ case: dir }).length, 0)

  // 重新丢弃一次 → 产生新的活判定
  ruleClause({ case: dir, file, clause: '第二条', kind: 'norevision', reason: '' })
  assert.equal(loadRulings({ case: dir }).length, 1)

  // 这条新判定必须能被作废（早期实现只看到"历史上作废过"就返回 already，导致作废不掉）
  const r = revokeRuling({ case: dir, file, clause: '第二条', reason: '第二次判定也写错了' })
  assert.ok(!r.already, '不能因为历史上有作废记录就跳过')
  assert.equal(loadRulings({ case: dir }).length, 0)

  const all = loadAllRulings({ case: dir })
  assert.equal(all.filter((x) => !x.__deleted).length, 2, '两条原判定都要保留（可审计）')
  assert.equal(all.filter((x) => x.__deleted).length, 2, '两条作废记录也都要在')
})

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openReview, addAttack, addReply, addVerdict, listReview, detectAdvice, unresolvedFatal } from '../lib/core/review.js'
import { newCase } from '../lib/core/case.js'
import { verifyCase } from '../lib/core/verify.js'

function tmpCase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-review-'))
  newCase({ dir, title: '复盘测试案', cause: '测试', parties: '甲；乙' })
  return dir
}

test('攻击阶段给建议必须被拒，且要说清为什么', () => {
  const c = tmpCase()
  openReview({ case: c, subject: 'K1 付款条件成就' })
  assert.throws(
    () => addAttack({ case: c, round: 'R1', target: 'K1', text: '付款条件这里证据不足，建议补充销售记录和银行流水作为依据。' }),
    /不许给建议/
  )
  assert.throws(
    () => addAttack({ case: c, round: 'R1', target: 'K1', text: '这里的推理链条断裂，应当修改为先证明退出行为再谈分配比例。' }),
    /不许给建议/
  )
})

test('纯攻击（只说哪里站不住）能通过', () => {
  const c = tmpCase()
  openReview({ case: c, subject: 'K1' })
  const r = addAttack({
    case: c, round: 'R1', target: 'K1',
    text: '协议约定的「退出可分配收入」没有定义，就直接套用 20% 比例，前提本身不成立。',
  })
  assert.equal(r.aid, 'A1')
  assert.match(r.summary, /R1\/A1/)
})

test('检测器能认出四类给方案措辞', () => {
  for (const s of ['建议补充银行流水', '应当修改这段表述', '可以考虑另一种解释', '正确的做法是先证明退出']) {
    assert.ok(detectAdvice(s).length > 0, s)
  }
  assert.equal(detectAdvice('这段引用与原文不一致').length, 0)
})

test('没回应不能裁定（没人辩护就定罪）', () => {
  const c = tmpCase()
  openReview({ case: c, subject: 'K1' })
  addAttack({ case: c, round: 'R1', text: '协议里根本没有「退出」的定义，20% 的计算基数不成立。' })
  assert.throws(() => addVerdict({ case: c, round: 'R1', aid: 'A1', severity: '致命', note: '确实不成立' }), /还没回应/)
})

test('回应只能一次，不能覆盖', () => {
  const c = tmpCase()
  openReview({ case: c, subject: 'K1' })
  addAttack({ case: c, round: 'R1', text: '协议里根本没有「退出」的定义，20% 的计算基数不成立。' })
  addReply({ case: c, round: 'R1', aid: 'A1', text: '协议第 4.2 条有定义，指的是股权转让款扣除税费后的金额。' })
  assert.throws(() => addReply({ case: c, round: 'R1', aid: 'A1', text: '我再补一句' }), /不能覆盖/)
})

test('裁定级别只有三档，致命/重大必须写理由', () => {
  const c = tmpCase()
  openReview({ case: c, subject: 'K1' })
  addAttack({ case: c, round: 'R1', text: '协议里根本没有「退出」的定义，20% 的计算基数不成立。' })
  addReply({ case: c, round: 'R1', aid: 'A1', text: '协议第 4.2 条有定义。' })
  assert.throws(() => addVerdict({ case: c, round: 'R1', aid: 'A1', severity: '严重', note: 'x' }), /只能是/)
  assert.throws(() => addVerdict({ case: c, round: 'R1', aid: 'A1', severity: '致命', note: '' }), /必须写裁定理由/)
  const ok = addVerdict({ case: c, round: 'R1', aid: 'A1', severity: '重大', note: '定义存在但适用范围有争议，需补充解释' })
  assert.equal(ok.severity, '重大')
})

test('裁定后不能再追加攻击', () => {
  const c = tmpCase()
  openReview({ case: c, subject: 'K1' })
  addAttack({ case: c, round: 'R1', text: '协议里根本没有「退出」的定义，20% 的计算基数不成立。' })
  addReply({ case: c, round: 'R1', aid: 'A1', text: '协议第 4.2 条有定义。' })
  addVerdict({ case: c, round: 'R1', aid: 'A1', severity: '一般', note: '' })
  assert.throws(() => addAttack({ case: c, round: 'R1', text: '再补一个攻击点，关于税费扣除口径的问题。' }), /进入裁定/)
})

test('未闭环的致命项会被五道验收抓出来', () => {
  const c = tmpCase()
  openReview({ case: c, subject: 'K1' })
  addAttack({ case: c, round: 'R1', text: '协议里根本没有「退出」的定义，20% 的计算基数不成立。' })
  addReply({ case: c, round: 'R1', aid: 'A1', text: '协议第 4.2 条有定义。' })
  addVerdict({ case: c, round: 'R1', aid: 'A1', severity: '致命', note: '定义确实缺失，结论站不住' })
  const fatal = unresolvedFatal(c)
  assert.equal(fatal.length, 1)
  const v = verifyCase({ case: c })
  const logic = v.checks.find((x) => x.name === 'logic')
  assert.equal(logic.status, 'fail')
  assert.ok(logic.items.some((i) => /判为致命仍未闭环/.test(i.msg)))
})

test('标了「已处理」的致命项不再算未闭环', () => {
  const c = tmpCase()
  openReview({ case: c, subject: 'K1' })
  addAttack({ case: c, round: 'R1', text: '协议里根本没有「退出」的定义，20% 的计算基数不成立。' })
  addReply({ case: c, round: 'R1', aid: 'A1', text: '协议第 4.2 条有定义。' })
  addVerdict({ case: c, round: 'R1', aid: 'A1', severity: '致命', note: '定义缺失，已处理：结论改为不主张该比例' })
  assert.equal(unresolvedFatal(c).length, 0)
})

test('复盘进度汇总能看清三回合各自走到哪', () => {
  const c = tmpCase()
  openReview({ case: c, subject: 'K1' })
  addAttack({ case: c, round: 'R1', text: '协议里根本没有「退出」的定义，20% 的计算基数不成立。' })
  addAttack({ case: c, round: 'R1', text: '保全金额与诉请金额不一致，缺口没有说明。' })
  addReply({ case: c, round: 'R1', aid: 'A1', text: '协议第 4.2 条有定义。' })
  const r = listReview({ case: c })
  assert.equal(r.roundCount, 1)
  assert.equal(r.rounds[0].counts.attacks, 2)
  assert.equal(r.rounds[0].counts.replied, 1)
  assert.equal(r.rounds[0].counts.judged, 0)
  assert.match(r.summary, /R1 2攻\/1应\/0裁/)
})

test('没开轮次就攻击要明确报错', () => {
  const c = tmpCase()
  assert.throws(() => addAttack({ case: c, round: 'R9', text: '随便一个够长的攻击点描述内容' }), /没有 R9 这一轮/)
})

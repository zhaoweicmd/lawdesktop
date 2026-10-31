// 合同预检（A）的测试：机器能判的硬伤必须判准，判不了的必须自我声明。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { casePaths } from '../lib/core/store.js'
import { precheckDocument, precheckCase } from '../lib/core/precheck.js'

const C = (no, heading, text) => ({ no, heading, text })

function sample() {
  return [
    C('第一条', '第一条 合同主体', '第一条 合同主体\n甲方：____，乙方：____。'),
    C('第二条', '第二条 价款与付款', '第二条 价款与付款\n合同总价为人民币〔金额〕元；签订后 3 日内一次性付款。'),
    C('第三条', '第三条 交付与验收', '第三条 交付与验收\n卖方应于 2026 年 12 月 31 日前交付；买方应于交付后 7 日内验收，逾期未验收视为验收合格。'),
    C('第五条', '第五条 争议解决', '第五条 争议解决\n任何争议提交北京仲裁委员会仲裁。详见附件1。'),
  ]
}

test('占位符：下划线、〔〕模板占位都要报，带条款号与原文片段', () => {
  const r = precheckDocument({ fileName: '甲.docx', clauses: sample() })
  const ph = r.findings.filter((f) => f.ruleId === 'placeholder')
  assert.ok(ph.length >= 2)
  assert.ok(ph.some((f) => /下划线/.test(f.title) && f.clause === '第一条'))
  assert.ok(ph.some((f) => /〔〕/.test(f.title) && f.clause === '第二条'))
  assert.ok(ph.every((f) => f.quote), '每条占位符结论都要给出原文片段')
  assert.equal(ph[0].level, '重大风险')
})

test('占位符：待填写 / XX / 空括号也认得', () => {
  const r = precheckDocument({
    clauses: [
      C('第一条', '第一条 标的', '第一条 标的\n产品型号：XX，数量待填写，金额（　）元。'),
    ],
  })
  const labels = r.findings.filter((f) => f.ruleId === 'placeholder').map((f) => f.title).join(' ')
  assert.match(labels, /待填字样|XX 占位|空括号/)
})

test('条款编号重复：报重大风险；跳号只提示、不替人判断', () => {
  const r = precheckDocument({
    clauses: [C('第一条', '', '第一条 x'), C('第二条', '', '第二条 x'), C('第四条', '', '第四条 x'), C('第四条', '', '第四条 x')],
  })
  const dup = r.findings.filter((f) => f.ruleId === 'clause-number' && f.level === '重大风险')
  assert.equal(dup.length, 1)
  assert.match(dup[0].title, /重复/)
  const gap = r.findings.filter((f) => f.ruleId === 'clause-number' && f.level === '提示')
  assert.equal(gap.length, 1)
  assert.match(gap[0].detail, /人工确认/)
})

test('「总则」「附件一」这类非条号不当成第 0 条（否则会误报重号）', () => {
  const r = precheckDocument({
    clauses: [C('第一条', '', '第一条 x'), C('总则', '', '总则 适用范围'), C('附件一', '', '附件一 清单')],
  })
  assert.equal(r.findings.filter((f) => f.ruleId === 'clause-number').length, 0)
})

test('引用了附件但没有附件条款：报建议修改', () => {
  const r = precheckDocument({ clauses: sample() })
  const att = r.findings.find((f) => f.ruleId === 'attachment')
  assert.ok(att)
  assert.equal(att.level, '建议修改')
  assert.match(att.detail, /附件1/)
})

test('有关键词覆盖：只在缺失时报，且明确声明「关键词法不等于条款充分」', () => {
  const r = precheckDocument({ clauses: sample() })
  const cov = r.findings.filter((f) => f.ruleId === 'coverage')
  // 样本里有付款/验收/争议，缺违约、期限、保密
  const titles = cov.map((f) => f.title).join(' ')
  assert.match(titles, /违约责任/)
  assert.ok(!/付款与价款/.test(titles), '已经出现的条款不该报缺失')
  assert.ok(cov.every((f) => /只检查关键词是否出现/.test(f.detail)))
  assert.equal(cov[0].level, '提示')
})

test('没有签署安排要报；有的不报', () => {
  const without = precheckDocument({ clauses: sample() })
  assert.ok(without.findings.some((f) => f.ruleId === 'signature'))
  const withSign = precheckDocument({
    clauses: [...sample(), C('第九条', '第九条 签署', '第九条 签署\n本合同自双方签字盖章之日起生效。')],
  })
  assert.ok(!withSign.findings.some((f) => f.ruleId === 'signature'))
})

test('结果按严重度排序，编号跟着显示顺序（PC1 是最严重的）', () => {
  const r = precheckDocument({ clauses: sample() })
  const order = { 重大风险: 0, 建议修改: 1, 提示: 2 }
  for (let i = 1; i < r.findings.length; i += 1) {
    assert.ok(order[r.findings[i - 1].level] <= order[r.findings[i].level], '级别必须从高到低')
  }
  assert.equal(r.findings[0].id, 'PC1')
  assert.equal(r.byLevel['重大风险'], r.findings.filter((f) => f.level === '重大风险').length)
})

test('干净的合同：预检通过，不硬造问题', () => {
  const r = precheckDocument({
    fileName: '规范合同.docx',
    clauses: [
      C('第一条', '第一条 主体', '第一条 主体\n甲方：某某公司，乙方：某某公司，双方有权签署。'),
      C('第二条', '第二条 价款与付款', '第二条 价款与付款\n合同总价人民币 100 万元，验收合格后 10 日内付款。'),
      C('第三条', '第三条 交付与验收', '第三条 交付与验收\n交付地点为甲方仓库，验收标准见附件清单。'),
      C('第四条', '第四条 违约责任', '第四条 违约责任\n逾期交付按日万分之五承担违约金，并赔偿损失。'),
      C('第五条', '第五条 争议解决', '第五条 争议解决\n争议提交北京仲裁委员会仲裁。'),
      C('第六条', '第六条 期限与生效', '第六条 期限与生效\n本合同自双方法定代表人或授权代表签字盖章之日起生效。'),
      C('第七条', '第七条 保密', '第七条 保密\n双方对商业秘密承担保密义务。'),
    ],
  })
  assert.equal(r.count, 0, JSON.stringify(r.findings))
  assert.match(r.summary, /预检通过/)
})

test('precheckCase：读案件里的条款索引；没索引要说人话', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-precheck-'))
  newCase({ dir, title: '预检案', caseType: 'contract' })

  assert.throws(() => precheckCase({ case: dir }), /还没有条款索引/)

  fs.writeFileSync(
    casePaths(dir).clauses,
    JSON.stringify({ files: [{ file: '/fake/采购合同.docx', name: '采购合同.docx', clauses: sample() }] }, null, 2),
    'utf8'
  )
  const r = precheckCase({ case: dir })
  assert.equal(r.ok, true)
  assert.equal(r.files.length, 1)
  assert.ok(r.count > 0)
  assert.match(r.note, /仍需人工判断/, '必须声明预检不能替代人工复核')
  assert.ok(r.findings.every((f) => f.file === '采购合同.docx'), '多合同时要标明是哪一份')
})

test('precheckCase：指定不存在的合同要给可执行报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-precheck2-'))
  newCase({ dir, title: '预检案2', caseType: 'contract' })
  fs.writeFileSync(
    casePaths(dir).clauses,
    JSON.stringify({ files: [{ file: '/fake/a.docx', name: 'a.docx', clauses: sample() }] }, null, 2),
    'utf8'
  )
  assert.throws(() => precheckCase({ case: dir, file: 'b.docx' }), /条款索引里没有这份合同/)
})

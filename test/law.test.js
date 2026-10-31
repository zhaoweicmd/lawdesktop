import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { articleNumber, addLaw, loadLaws, localVerdict, probePkulaw } from '../lib/core/law.js'
import { newCase } from '../lib/core/case.js'

function tmpCase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-law-'))
  newCase({ dir, title: '法条测试案', cause: '测试', parties: '甲；乙' })
  return dir
}

test('条号中文数字要转对（含千位）', () => {
  assert.equal(articleNumber('第五百零九条'), 509)
  assert.equal(articleNumber('第一千二百六十条'), 1260)
  assert.equal(articleNumber('第一千一百六十八条'), 1168)
  assert.equal(articleNumber('第二条'), 2)
  assert.equal(articleNumber('第509条'), 509)
})

test('法规名/条号必填，缺了就拒', () => {
  const c = tmpCase()
  assert.throws(() => addLaw({ case: c, title: '', article: '第五百零九条' }), /法规名称必填/)
  assert.throws(() => addLaw({ case: c, title: '民法典', article: '' }), /条号必填/)
  assert.throws(() => addLaw({ case: c, title: '民法典', article: '第五百零九条', source: '瞎写' }), /来源类型/)
})

test('只写条号不写原文 → 标为未回源', () => {
  const c = tmpCase()
  const r = addLaw({ case: c, title: '中华人民共和国民法典', article: '第五百零九条', source: 'manual' })
  assert.equal(r.law.status, 'unverified')
  const v = localVerdict(r.law)
  assert.equal(v.level, 'warn')
  assert.match(v.items[0].msg, /只有条号没有条文原文/)
})

test('同一法规同一条号不能重复登记', () => {
  const c = tmpCase()
  addLaw({ case: c, title: '中华人民共和国民法典', article: '第五百零九条', quote: '当事人应当按照约定全面履行自己的义务。' })
  assert.throws(
    () => addLaw({ case: c, title: '中华人民共和国民法典', article: '第509条', quote: '这是与前面登记内容不同的一段条文原文，用来测试重复拦截是否生效。' }),
    /已登记为 L1/
  )
})

test('手工来源即使有原文也只是 warn（未经权威库核对）', () => {
  const c = tmpCase()
  const r = addLaw({ case: c, title: '中华人民共和国民法典', article: '第五百七十七条', quote: '当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。', source: 'manual' })
  assert.equal(r.law.status, 'local-ok')
  const v = localVerdict(r.law)
  assert.equal(v.level, 'warn')
  assert.ok(v.items.some((i) => /手工录入/.test(i.msg)))
})

test('已废止的法条必须判 fail', () => {
  const c = tmpCase()
  const r = addLaw({ case: c, title: '中华人民共和国合同法', article: '第一百零七条', quote: '当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。', source: 'official', repealedAt: '2021-01-01' })
  const v = localVerdict(r.law)
  assert.equal(v.level, 'fail')
  assert.ok(v.items.some((i) => /已.*废止/.test(i.msg)))
})

test('未安装北大法宝时探测要给出可执行的提示，不能只说失败', async () => {
  const r = await probePkulaw({ command: 'pkulaw-mcp-does-not-exist-xyz' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /未安装|找不到命令|npm i -g/)
})

test('台账读取按 id 合并，后写的状态覆盖', () => {
  const c = tmpCase()
  addLaw({ case: c, title: '中华人民共和国民法典', article: '第五百零九条', quote: '当事人应当按照约定全面履行自己的义务。' })
  const laws = loadLaws(c)
  assert.equal(laws.length, 1)
  assert.equal(laws[0].id, 'L1')
  assert.equal(laws[0].articleNum, 509)
})

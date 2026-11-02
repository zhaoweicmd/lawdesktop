// 切条款的编号卫生：前言列举不能被当成条款，重复条号不能被保留。
//
// 真机背景（2026-11-01）：合同审核案里，`clauses.json` 同时存在
//   `1`/`2`/`3`（前言里的编号列举）和 `第一条`…`第十五条`（正文）。
// 后果三条，全都真实发生：
//   1. 同一条款在界面上渲染两次；
//   2. 意见记在「第一条」下，而某处渲染用的是 `1`，键对不上 ⇒
//      「批注 / 改正文」按钮不出现、updateId 丢失；
//   3. 保存时误报「已登记过相同问题 N1」，让人去点一个不存在的「更新」按钮。

import test from 'node:test'
import assert from 'node:assert/strict'
import { splitClauses } from '../lib/core/clause.js'

const P = (arr) => arr.map((t, i) => ({ n: i + 1, text: t }))

test('★ 有「第X条」体系时，前言里的 1、2、3、不算条款', () => {
  const cs = splitClauses(
    P([
      '合作投资协议',
      '1、甲方与乙方拟共同出资设立一家公司。',
      '2、丙方系品牌方。',
      '3、甲方与乙方按约定出资。',
      '第一条 定义与解释',
      '本协议下列词语含义如下。',
      '第二条 A公司设立与股权结构',
      '2.1 甲方与乙方共同出资。',
    ])
  )
  const nos = cs.map((c) => c.no)
  assert.deepEqual(nos, ['第一条', '第二条'], `前言编号混进来了：${nos.join(',')}`)
})

test('纯数字编号的合同（没有「第X条」）仍然照常切', () => {
  const cs = splitClauses(P(['1. 服务费用', '甲方支付服务费。', '2. 交付', '乙方交付成果。']))
  assert.deepEqual(cs.map((c) => c.no), ['1', '2'])
})

test('★ 重复条号只保留第一次（正文 + 附件各有一套的情况）', () => {
  const cs = splitClauses(
    P(['第一条 正文甲', '内容甲。', '第二条 正文乙', '内容乙。', '第一条 附件甲', '附件内容。'])
  )
  const nos = cs.map((c) => c.no)
  assert.deepEqual(nos, ['第一条', '第二条'], `重复条号没去掉：${nos.join(',')}`)
  // 保留的必须是正文那条，不能被附件覆盖
  assert.match(cs[0].text, /内容甲/)
})

test('切出来的每条都有 no / heading / text，面板不会拿到 undefined', () => {
  const cs = splitClauses(P(['第一条 甲', '正文。']))
  assert.equal(cs.length, 1)
  for (const k of ['no', 'heading', 'text']) assert.equal(typeof cs[0][k], 'string', `缺 ${k}`)
})

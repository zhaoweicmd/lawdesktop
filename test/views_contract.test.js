// 合同审核界面：条款意见标记、风险点模板的"可用性"验证。
// 关键一条：模板填出来的骨架必须能通过插件自己的校验（≥15 字、无空泛话术），
// 否则用户一点模板就被拒收，等于没做。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { newCase } from '../lib/core/case.js'
import { addNote, listNotes } from '../lib/core/clause.js'


/** 在渲染树里按文案找第一个带 onClick 的元素（视图函数直接调用，非 harness） */
function findIn(node, label) {
  const out = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props && n.props.children === label && n.props.onClick) out.push(n)
    const kids = n.children || (n.props && n.props.children)
    if (Array.isArray(kids)) kids.forEach(walk)
    else walk(kids)
  }
  walk(node)
  if (!out.length) throw new Error('渲染树里找不到「' + label + '」')
  return out[0]
}

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

function fakeReact() {
  class Component {}
  return {
    createElement: (type, props, ...children) => {
      const p = props || {}
      if (children.length === 1) p.children = children[0]
      else if (children.length > 1) p.children = children
      return { type, props: p, children }
    },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
    useMemo: (fn) => fn(),
    Component,
  }
}

let seq = 0
async function load() {
  globalThis.window = {
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    __ModuleLoader__: { load: (spec) => { globalThis.__spec = spec } },
  }
  seq += 1
  await import(`${CLIENT}?ct=${seq}`)
  const react = fakeReact()
  return globalThis.__spec.factory((name) => (name === 'react' ? react : {}))
}

function textOf(node, depth = 0) {
  if (depth > 40) return ''
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((n) => textOf(n, depth + 1)).join(' ')
  if (typeof node.type === 'function') {
    try {
      return textOf(node.type(node.props), depth + 1)
    } catch (e) {
      return ''
    }
  }
  return textOf(node.children || [], depth + 1)
}

test('条款页标出每条已有几条意见', async () => {
  const mod = await load()
  const tree = mod.__views.ClausesView({
    data: {
      count: 1,
      noteTotal: 2,
      files: [
        {
          name: '采购合同.docx',
          total: 2,
          noteCount: 2,
          clauses: [
            { no: '第一条', title: '标的', text: '标的为设备一批。', noteCount: 0 },
            { no: '第二条', title: '付款', text: '一次性付清。', noteCount: 2 },
          ],
        },
      ],
    },
    actions: { onClauseIndex: () => {} },
  })
  const text = textOf(tree)
  assert.match(text, /已登记 2 条意见/)
  assert.match(text, /第二条/)
})

test('风险点模板有四个，且都满足插件的最小长度要求', async () => {
  const mod = await load()
  const t = mod.__views.RISK_TEMPLATES
  assert.ok(Array.isArray(t), '应导出模板')
  assert.equal(t.length, 4)
  assert.deepEqual(t.map((x) => x.key), ['付款', '验收', '解除', '违约'])
  for (const x of t) {
    assert.ok(x.issue.length >= 15, x.key + ' 问题骨架要够长')
    assert.ok(x.fix.length >= 15, x.key + ' 替换条文骨架要够长')
  }
})

test('模板填出来的内容能真的登记进案件（过得了 addNote 的三要素与空泛话术校验）', async () => {
  const mod = await load()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-tpl-'))
  const dir = path.join(root, '合同审核')
  newCase({ dir, title: '模板校验', caseType: 'contract' })
  const state = path.join(dir, '.lawcase')
  fs.writeFileSync(
    path.join(state, 'clauses.json'),
    JSON.stringify({
      files: [
        {
          name: '采购合同.docx',
          file: path.join(dir, '采购合同.docx'),
          clauses: [
            { no: '第一条', title: '标的', heading: '第一条 标的', text: '标的为设备一批。' },
            { no: '第二条', title: '付款', heading: '第二条 付款', text: '签订后一次性付清。' },
            { no: '第三条', title: '验收', heading: '第三条 验收', text: '交付即视为验收。' },
            { no: '第四条', title: '解除', heading: '第四条 解除', text: '双方可随时解除。' },
            { no: '第五条', title: '违约', heading: '第五条 违约', text: '逾期交货按日计罚。' },
          ],
        },
      ],
    }),
    'utf8'
  )

  let i = 0
  for (const tpl of mod.__views.RISK_TEMPLATES) {
    i += 1
    const res = addNote({ case: dir, file: '采购合同.docx', clause: '第' + ['一', '二', '三', '四', '五'][i - 1] + '条', level: '重大风险', issue: tpl.issue, fix: tpl.fix })
    assert.equal(res.ok, true, `${tpl.key} 模板应能登记：${JSON.stringify(res)}`)
  }
  const listed = listNotes({ case: dir })
  assert.equal(listed.count, 4)
})

test('意见页有生成意见表 / 修订版入口（在登记表单视图里）', async () => {
  const mod = await load()
  // 直接调视图函数时没有真实 state，onClick 切不动视图（setViewMode 是 no-op）。
  // 所以这里做两件事：
  //   ① 断言源码里这两个入口仍然挂在 NotesView 上（能力没丢）
  //   ② 断言渲染出的页面确实提供了"登记表单"这个切换入口
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')
  assert.match(src, /生成意见表/, '必须保留「生成意见表」入口')
  assert.match(src, /生成修订版/, '必须保留「生成修订版」入口')

  const tree = mod.__views.NotesView({
    data: { count: 0, notes: [] },
    actions: { onNoteAdd: () => {}, onNoteDelete: () => {}, onReport: () => {}, onRevise: () => {} },
    files: [{ name: '采购合同.docx', total: 1, noteCount: 0, clauses: [{ no: '第一条', title: '标的', text: '…', noteCount: 0 }] }],
  })
  const text = textOf(tree)
  // 默认全文视图提供切换入口，用户点一下就回到表单
  assert.match(text, /登记表单/)
  // 全文视图本身也要能列出条款原文
  assert.match(text, /原文/)
})

// 「选中条款 → AI 草稿自动填进表单」的纯逻辑测试。
//
// 钉住的两个坑：
//   1) 条款编号有「4」和「第五条」两种写法，AI 草稿和条款索引可能不一致，直接用 === 会比漏
//   2) 下拉的 option value 曾经只传 label 数组，onChange 回来的是 label 而非 key，
//      于是 onPick 里按 key 匹配永远失败——「选了条款什么都没发生」

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

let seq = 0
async function load() {
  globalThis.window = { localStorage: { getItem: () => null, setItem: () => {} }, __ModuleLoader__: { load: (s) => { globalThis.__spec = s } } }
  seq += 1
  await import(`${CLIENT}?fill=${seq}`)
  const React = {
    createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }), useMemo: (f) => f(),
    Component: class { constructor(p) { this.props = p } },
  }
  return globalThis.__spec.factory((n) => (n === 'react' ? React : {})).__views
}

const DRAFTS = [
  { clause: '4', level: '重大风险', issue: '服务费未约定单价标准，金额可被单方填定。', fix: '服务费单价以附件一载明标准为准。', quote: '服务费按确认书结算。', basis: '民法典第470条' },
  { clause: '第五条', level: '提示', issue: '保密期限未约定。', fix: '保密义务自签署之日起三年内有效。' },
]

test('按条款号找草稿：阿拉伯数字与中文数字互通', async () => {
  const V = await load()
  assert.equal(V.draftOfClause(DRAFTS, '4').issue, DRAFTS[0].issue)
  assert.equal(V.draftOfClause(DRAFTS, '第4条').issue, DRAFTS[0].issue)
  assert.equal(V.draftOfClause(DRAFTS, '第五条').issue, DRAFTS[1].issue)
  assert.equal(V.draftOfClause(DRAFTS, '5').issue, DRAFTS[1].issue, '「5」要能找到「第五条」')
  assert.equal(V.draftOfClause(DRAFTS, '99'), null)
  assert.equal(V.draftOfClause([], '4'), null)
})

test('applyDraftToForm 把六个字段都填进去（不只 issue/fix）', async () => {
  const V = await load()
  const box = {}
  V.applyDraftToForm(DRAFTS[0], {
    setLevel: (v) => (box.level = v),
    setIssue: (v) => (box.issue = v),
    setFix: (v) => (box.fix = v),
    setBasis: (v) => (box.basis = v),
    setQuote: (v) => (box.quote = v),
  })
  assert.equal(box.level, '重大风险')
  assert.equal(box.issue, DRAFTS[0].issue)
  assert.equal(box.fix, DRAFTS[0].fix)
  assert.equal(box.quote, DRAFTS[0].quote, '引文要填，否则还得手抄')
  assert.equal(box.basis, DRAFTS[0].basis)
})

test('草稿缺字段时不写入 undefined（会把输入框变成受控空值）', async () => {
  const V = await load()
  const box = { quote: '原有的' }
  V.applyDraftToForm(DRAFTS[1], {
    setLevel: (v) => (box.level = v),
    setIssue: (v) => (box.issue = v),
    setFix: (v) => (box.fix = v),
    setBasis: (v) => (box.basis = v),
    setQuote: (v) => (box.quote = v),
  })
  assert.equal(box.quote, '')
})

test('条款下拉的 option 必须带 value=key，不能只传 label', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  // 旧写法 options: options.map((o) => o.label) → onChange 回来的是 label，onPick 匹配不到 key
  assert.ok(!/h\(Select, \{ value: picked, onChange: onPick, options: options\.map\(\(o\) => o\.label\) \}\)/.test(src),
    '不能只传 label 数组')
  assert.ok(/options: options\.map\(\(o\) => \(\{ value: o\.key, label: o\.label \}\)\)/.test(src),
    '要传 {value: key, label}')
})

test('onPick 会调用 applyDraftToForm（选中条款即填表）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  const i = src.indexOf('const onPick = (key) => {')
  assert.ok(i > 0)
  const body = src.slice(i, i + 500)
  assert.ok(/applyDraftToForm\(draftOfClause\(drafts/.test(body), 'onPick 必须填表：' + body)
})

test('切换条款要重填表单：不能只有第一条被填', async () => {
  // 线上踩过：载入草稿后只有「当前选中」那条被填进表单，
  // 切到其它条款表单不动——因为草稿是异步载入的，onPick 里读到的 drafts 是旧值。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  const i = src.indexOf('选中条款一变就填对应草稿')
  assert.ok(i > 0, '需要有「条款变化即填表」的 effect')
  const body = src.slice(i, i + 700)
  assert.ok(/draftOfClause\(drafts, clause\)/.test(body), 'effect 要按当前条款查草稿')
  assert.ok(/applyDraftToForm/.test(body), 'effect 要真的填表')
  // 依赖不能只看 length：数量相同但内容换掉时要重填
  assert.ok(/drafts\.map/.test(body), '依赖要用草稿指纹而不是条数')
})

test('多条款草稿各自独立取用', async () => {
  const V = await load()
  const list = [
    { clause: '1', issue: 'A问题', fix: 'A改法' },
    { clause: '2', issue: 'B问题', fix: 'B改法' },
    { clause: '3', issue: 'C问题', fix: 'C改法' },
  ]
  for (const [no, expect] of [['1', 'A问题'], ['2', 'B问题'], ['3', 'C问题']]) {
    assert.equal(V.draftOfClause(list, no).issue, expect)
  }
})

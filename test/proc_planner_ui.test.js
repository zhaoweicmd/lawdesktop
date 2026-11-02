// 工序页「在工作台里拆工序」的接线测试（2026-11-01）。
//
// 真机教训：工序表为空时，界面只给一句
// 「工序表为空（在对话里让助手 lc_proc_plan）」——工作台里没有入口，
// 用户被推回对话框去用自然语言描述一个带依赖的 DAG，既啰嗦又容易被打回。
//
// 这组测试钉住四件事：
//   1. 空表必须直接给建表器，而不是只给一句提示
//   2. 没写验收标准必须拦住（core 会拒收，界面要先说清楚）
//   3. 提交时 dependsOn 要拆成数组、空依赖不能变成 [""]
//   4. runAction 失败吞异常、成功返回 data —— 成败判定不能靠 try/catch

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const SRC = fs.readFileSync(CLIENT, 'utf8')

test('工序空表不再只提示「去对话里找助手」，而是渲染建表器', () => {
  // 注意：旧文案仍会出现在「解释为什么改成现在这样」的注释里，这是好事。
  // 要断言的是**渲染语句**里不再有它——所以找 h(Empty, null, ...) 那条。
  assert.equal(
    /h\(Empty, null, '[^']*工序表为空/.test(SRC),
    false,
    '空表不能再渲染成一句提示；若命中说明退回旧实现了'
  )
  assert.ok(SRC.includes('function ProcPlanner'), '必须有 ProcPlanner 组件')
  assert.ok(
    SRC.includes('h(ProcPlanner, { actions: act, onDone: props.onPlanned })'),
    '空表分支要直接渲染建表器'
  )
})

test('建表器要求验收标准必填，并给出人话原因', () => {
  const fn = sliceFn('ProcPlanner')
  assert.ok(/acceptance/.test(fn), '必须读验收标准')
  assert.ok(
    fn.includes('没写验收标准'),
    '缺验收标准要明确报错，不能静默提交（core 会直接拒收）'
  )
  assert.ok(
    fn.includes('canSubmit') && fn.includes('acceptance.trim().length > 0'),
    '按钮可用性要与验收标准挂钩'
  )
})

test('dependsOn 要按分隔符拆数组，空依赖不能产生空字符串', () => {
  const fn = sliceFn('ProcPlanner')
  assert.ok(
    fn.includes('dependsOn: r.dependsOn.split'),
    'dependsOn 必须从输入框拆成数组'
  )
  assert.ok(
    fn.includes('.filter(Boolean)'),
    '空依赖要过滤掉，否则会变成 [""] 让 core 认成依赖一个空名工序'
  )
})

test('成功判定看返回值而非 try/catch（runAction 吞异常）', () => {
  const fn = sliceFn('ProcPlanner')
  assert.ok(
    fn.includes('if (r) {'),
    'runAction 失败返回 undefined、成功返回 data，必须据此判断'
  )
  assert.ok(fn.includes('const r = await act.onProcPlan'), '必须调用 onProcPlan')
  assert.ok(fn.includes('finally'), '必须复位 busy，否则按钮会永久卡在「提交中…」')
})

test('已有工序表时提供重排入口，并提示会重置进度', () => {
  assert.ok(SRC.includes('重排工序表'), '有表也要能重排')
  assert.ok(SRC.includes('已标的完成/阻塞状态不会保留'), 'replace 会重置进度，必须提前说')
  assert.ok(SRC.includes('onProcPlan: (p) => runAction('), '必须接到 proc.plan')
})

test('建完表要刷新工序页，否则界面停在空表分支', () => {
  assert.ok(
    SRC.includes('onPlanned: () => {') && SRC.includes("props.onReloadTab('processes')"),
    'ProcView 的 onPlanned 必须触发 processes 重读'
  )
  const fn = sliceFn('reloadCurrentTab')
  assert.ok(
    fn.includes('whichOverride') && fn.includes('whichOverride || TAB_KEY[tab]'),
    'reloadCurrentTab 要支持指定页；否则传参会静默刷成当前页'
  )
})

/** 粗切出某个函数体，避免整文件断言被别的同名片段误命中。
 *  兼容两种写法：`function X(` 与 `const X = ...=>`。 */
function sliceFn(name) {
  let i = SRC.indexOf('function ' + name)
  if (i < 0) i = SRC.indexOf('const ' + name + ' =')
  assert.ok(i >= 0, `找不到 ${name}`)
  // 取到下一个顶层函数声明为止（够用：客户端里这些函数之间没有同名嵌套）
  const rest = SRC.slice(i + 10)
  const m = rest.search(/\n {4}function /)
  return m >= 0 ? rest.slice(0, m) : rest
}

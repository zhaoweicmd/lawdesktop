// 界面状态与"单案根目录"的测试。
// 背景：面板把根目录存在 localStorage，而 DSH 每次启动端口随机 ⇒ origin 变 ⇒ 记忆丢失。
// 改为存到插件状态目录后，必须验证跨实例仍能读回。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { createApi, listCases } from '../lib/server/api.js'

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

test('root 指向单个案件目录时，直接返回这一件（用户常这么填）', () => {
  const root = tmp('lawcase-single-')
  const caseDir = path.join(root, '某某合同诈骗案')
  newCase({ dir: caseDir, title: '某某合同诈骗案', cause: '合同诈骗' })
  fs.writeFileSync(path.join(caseDir, '刑事控告书.txt'), '控告书正文\n', 'utf8')

  const out = listCases({ root: caseDir })
  assert.equal(out.count, 1)
  assert.equal(out.single, true)
  assert.equal(out.cases[0].title, '某某合同诈骗案')
})

// 回归：根目录自己误带上了 .lawcase（建案时把目录填成了总目录），
// 曾经会「直接返回这一件」，把里面的真实案件全屏蔽掉——用户看到的是
// 「我明明有 5 个案子，列表里只有一个」。
test('root 自身是案件、但里面还有别的案件时，不能把里面那些吞掉', () => {
  const root = tmp('lawcase-rootcase-')
  // 三个真实案件
  for (const name of ['甲案', '乙案', '丙案']) {
    newCase({ dir: path.join(root, name), title: name })
  }
  // 误建在根目录上的那一件
  const misfiled = path.join(root, '.lawcase')
  fs.mkdirSync(misfiled, { recursive: true })
  fs.writeFileSync(
    path.join(misfiled, 'case.json'),
    JSON.stringify({ caseId: 'x', title: '误建在根目录的案', caseType: 'contract', updatedAt: '2020-01-01T00:00:00.000Z' })
  )

  const out = listCases({ root })
  assert.equal(out.count, 4, '根目录那件 + 里面 3 件，一件都不能少')
  assert.equal(out.selfIsCase, true)
  assert.equal(out.single, false, '里面还有别的案件，就不是单案根目录')
  const titles = out.cases.map((c) => c.title).sort()
  assert.deepEqual(titles, ['丙案', '乙案', '甲案', '误建在根目录的案'].sort())
})

test('建案时不许把「案件总目录」本身建成案件（下面已经有案件就拒绝）', () => {
  const root = tmp('lawcase-guard-')
  newCase({ dir: path.join(root, '已有案'), title: '已有案' })
  assert.throws(
    () => newCase({ dir: root, title: '误建' }),
    /案件总目录/,
    '应当拒绝并说清这是总目录'
  )
  assert.ok(!fs.existsSync(path.join(root, '.lawcase', 'case.json')), '被拒后不能真的落下 case.json')
})

test('root 是普通目录（没有 .lawcase 子目录）时返回空列表而不是报错', () => {
  const root = tmp('lawcase-plain-')
  fs.mkdirSync(path.join(root, '材料'), { recursive: true })
  const out = listCases({ root })
  assert.equal(out.count, 0)
})

test('ui.state 跨实例记住根目录与上次打开的案件', async () => {
  const pkgRoot = tmp('lawcase-pkg-')
  const a = createApi({ version: 't', root: '/fallback', pkgRoot })
  const set = await a.handle('ui.state.set', { root: '/my/cases', lastCase: '/my/cases/案一' })
  assert.equal(set.ok, true)

  // 新实例（相当于应用重启）应能读回
  const b = createApi({ version: 't', root: '/fallback', pkgRoot })
  const st = await b.handle('ui.state', {})
  assert.equal(st.ok, true)
  assert.equal(st.data.storedRoot, '/my/cases')
  assert.equal(st.data.lastCase, '/my/cases/案一')
  assert.ok(fs.existsSync(path.join(pkgRoot, '.lawcase-plugin', 'ui-state.json')), '状态应落盘')
})

test('ui.state 未设置过时回落到配置里的 root', async () => {
  const pkgRoot = tmp('lawcase-pkg2-')
  const api = createApi({ version: 't', root: '/from-config', pkgRoot })
  const st = await api.handle('ui.state', {})
  assert.equal(st.data.root, '/from-config')
  assert.equal(st.data.storedRoot, null)
})

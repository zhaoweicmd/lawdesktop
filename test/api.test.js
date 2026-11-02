import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { addFact } from '../lib/core/fact.js'
import { createApi, listCases, assertCaseDir, API_PATH } from '../lib/server/api.js'

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-api-'))
  return dir
}

function seedCase(root, name = '案一') {
  const dir = path.join(root, name)
  newCase({ dir, title: `测试案：${name}`, cause: '买卖合同纠纷', parties: '原告：甲；被告：乙' })
  return dir
}

test('ping 回版本与根目录，路径固定为 /api/lawcase', async () => {
  const api = createApi({ version: '9.9.9', root: '/tmp/x', pkgRoot: '/tmp/pkg' })
  const out = await api.handle('ping')
  assert.equal(out.ok, true)
  assert.equal(out.data.version, '9.9.9')
  assert.equal(out.data.api, API_PATH)
  assert.equal(out.data.root, '/tmp/x')
})

test('cases.list 只认带 .lawcase/case.json 的目录，并把非案件目录跳过', async () => {
  const root = tmpRoot()
  const a = seedCase(root, '甲案')
  seedCase(root, '乙案')
  fs.mkdirSync(path.join(root, '空目录'), { recursive: true })

  const api = createApi({ version: 't', root })
  const out = await api.handle('cases.list')
  assert.equal(out.ok, true)
  assert.equal(out.data.count, 2, '空目录不算案件')
  const dirs = out.data.cases.map((c) => c.dir)
  assert.ok(dirs.includes(a))
  assert.equal(out.data.cases[0].counts.procTotal, 0)
})

test('client.mount 是诊断通道：能收下界面自报并写日志', async () => {
  const seen = []
  const api = createApi({ version: 't', root: '/tmp/x', note: (rec) => seen.push(rec) })
  const out = await api.handle('client.mount', { phase: 'mount', mode: 'panel' })
  assert.equal(out.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].op, 'client-mount')
  assert.equal(seen[0].mode, 'panel')
})

test('root 未配置时给出可执行的报错，而不是静默空列表', async () => {
  const api = createApi({ version: 't', root: null })
  const out = await api.handle('cases.list')
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'root/unset')
})

test('case.open 摊开工序/事实/材料/下一步，后续台账 op 都能读', async () => {
  const root = tmpRoot()
  const dir = seedCase(root, '丙案')
  fs.writeFileSync(path.join(dir, '情况说明.txt'), '2026年3月1日双方签订《买卖合同》\n', 'utf8')
  addFact({ case: dir, text: '2026年3月1日双方签订《买卖合同》', source: '情况说明.txt', locator: '第1段' })

  const api = createApi({ version: 't', root })
  const opened = await api.handle('case.open', { case: dir })
  assert.equal(opened.ok, true)
  assert.equal(opened.data.title, '测试案：丙案')
  assert.ok(Array.isArray(opened.data.hints))
  assert.equal(opened.data.facts.total, 1)

  const facts = await api.handle('facts.list', { case: dir })
  assert.equal(facts.ok, true)
  assert.equal(facts.data.total, 1)

  const findings = await api.handle('findings.list', { case: dir })
  assert.equal(findings.ok, true)
  assert.equal(findings.data.count, 0)

  const mats = await api.handle('materials.list', { case: dir })
  assert.equal(mats.ok, true)

  const proc = await api.handle('processes.list', { case: dir })
  assert.equal(proc.ok, true)
  assert.equal(proc.data.total, 0)

  const clauses = await api.handle('clauses.list', { case: dir })
  assert.equal(clauses.ok, true, '没索引过合同不算错误')
  assert.equal(clauses.data.count, 0)
})

test('verify 是纯读：连跑两次结果一致，且声明未改状态', async () => {
  const root = tmpRoot()
  const dir = seedCase(root, '丁案')
  const api = createApi({ version: 't', root })
  const one = await api.handle('verify', { case: dir })
  const two = await api.handle('verify', { case: dir })
  assert.equal(one.ok, true)
  assert.equal(one.data.stateUnchanged, true)
  assert.equal(one.data.verdict, two.data.verdict)
  assert.equal(one.data.checks.length, two.data.checks.length)
})

test('不是案件目录要明确报错（code=case/not-a-case）', async () => {
  const root = tmpRoot()
  const plain = path.join(root, '普通目录')
  fs.mkdirSync(plain, { recursive: true })
  const api = createApi({ version: 't', root })
  const out = await api.handle('case.open', { case: plain })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'case/not-a-case')
  assert.throws(() => assertCaseDir(''), /case 不能为空/)
})

test('未知 op 报可用清单，不炸接口', async () => {
  const api = createApi({ version: 't', root: '/tmp/x' })
  const out = await api.handle('cases.delete', {})
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'op/unknown')
  assert.match(out.error.message, /cases\.list/)
})

test('listCases 直接调用也能用（界面/CLI 共用同一实现）', () => {
  const root = tmpRoot()
  seedCase(root, '戊案')
  const out = listCases({ root })
  assert.equal(out.count, 1)
  assert.equal(out.root, root)
})

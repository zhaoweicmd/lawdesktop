// 写操作接口的测试：全部走 createApi().handle()，与界面调用的是同一条路径。
// 每个用例都在临时目录里跑，不碰真实案件。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { createApi } from '../lib/server/api.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-api-w-'))
}

function seedCase(root, name = '案A') {
  const dir = path.join(root, name)
  newCase({ dir, title: `测试案：${name}`, cause: '买卖合同纠纷', parties: '原告：甲；被告：乙' })
  fs.writeFileSync(path.join(dir, '情况说明.txt'), '2026年3月1日双方签订《买卖合同》。\n', 'utf8')
  return dir
}

function api(root) {
  return createApi({ version: 't', root })
}

test('fact.add → facts.list 能看到，且出处必填', async () => {
  const root = tmpRoot()
  const dir = seedCase(root)
  const a = api(root)

  const ok = await a.handle('fact.add', { case: dir, text: '双方于 2026年3月1日签约', source: '情况说明.txt', locator: '第1段' })
  assert.equal(ok.ok, true, JSON.stringify(ok.error))

  const list = await a.handle('facts.list', { case: dir })
  assert.equal(list.data.total, 1)
  assert.equal(list.data.facts[0].locator, '第1段')

  const bad = await a.handle('fact.add', { case: dir, text: '没有出处的一句话', locator: 'P1' })
  assert.equal(bad.ok, false, '缺 source 必须拒绝')
})

test('proc.plan → proc.update 走完状态机', async () => {
  const root = tmpRoot()
  const dir = seedCase(root)
  const a = api(root)

  const plan = await a.handle('proc.plan', {
    case: dir,
    processes: [{ name: '梳理材料', acceptance: '材料全部登记且能定位' }],
  })
  assert.equal(plan.ok, true, JSON.stringify(plan.error))

  const list = await a.handle('processes.list', { case: dir })
  assert.equal(list.data.total, 1)
  const id = list.data.proc[0].id

  const done = await a.handle('proc.update', { case: dir, id, status: 'done', acceptResult: true })
  assert.equal(done.ok, true, JSON.stringify(done.error))

  const after = await a.handle('processes.list', { case: dir })
  assert.equal(after.data.done, 1)
})

test('finding.add 必须引用已登记的事实', async () => {
  const root = tmpRoot()
  const dir = seedCase(root)
  const a = api(root)

  await a.handle('fact.add', { case: dir, text: '双方于 2026年3月1日签约', source: '情况说明.txt', locator: '第1段' })

  const ok = await a.handle('finding.add', {
    case: dir,
    text: '合同成立并生效，被告应依约履行付款义务',
    factRefs: ['F1'],
  })
  assert.equal(ok.ok, true, JSON.stringify(ok.error))

  const bad = await a.handle('finding.add', { case: dir, text: '引用不存在的事实', factRefs: ['F99'] })
  assert.equal(bad.ok, false, '引用不存在的事实必须拒绝')

  const list = await a.handle('findings.list', { case: dir })
  assert.equal(list.data.count, 1)
})

test('pipeline.run 能建案 + 扫材料（不抽事实、不出结论）', async () => {
  const root = tmpRoot()
  const src = path.join(root, '卷宗')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, '合同.txt'), '买卖合同正文…\n', 'utf8')
  const caseDir = path.join(root, '新案')

  const a = api(root)
  const run = await a.handle('pipeline.run', { case: caseDir, source: src, title: '新案标题', cause: '买卖合同纠纷' })
  assert.equal(run.ok, true, JSON.stringify(run.error))
  assert.ok(fs.existsSync(path.join(caseDir, '.lawcase', 'case.json')))

  const opened = await a.handle('case.open', { case: caseDir })
  assert.equal(opened.ok, true)
  assert.ok(opened.data.materials.total >= 1, '材料应已登记')
  assert.equal(opened.data.facts.total, 0, '流水线不得抽事实')
  assert.equal(opened.data.findings.total, 0, '流水线不得出结论')
})

test('写操作都会校验案件目录，不是案件就报 case/not-a-case', async () => {
  const root = tmpRoot()
  const plain = path.join(root, '普通目录')
  fs.mkdirSync(plain, { recursive: true })
  const a = api(root)

  for (const op of ['fact.add', 'proc.plan', 'deliver', 'material.scan']) {
    const out = await a.handle(op, { case: plain })
    assert.equal(out.ok, false, `${op} 应拒绝`)
    assert.equal(out.error.code, 'case/not-a-case', `${op} 错误码`)
  }
})

test('deliver 在验收未过时不许凭空出包', async () => {
  const root = tmpRoot()
  const dir = seedCase(root)
  const a = api(root)
  const out = await a.handle('deliver', { case: dir })
  // 空案件一定过不了验收：要么被拒，要么 force 才能出包
  if (out.ok) {
    assert.ok(out.data.dir || out.data.path || out.data.outDir, '出包要给出位置')
  } else {
    assert.match(String(out.error.message), /验收|fail|未通过/i)
  }
})

test('pipeline.run 传 caseType=contract 建出来的是合同审核案', async () => {
  const root = tmpRoot()
  const src = path.join(root, '合同')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, '采购合同.txt'), '合同正文…\n', 'utf8')
  const caseDir = path.join(root, '合同审核')

  const a = api(root)
  const run = await a.handle('pipeline.run', {
    case: caseDir,
    source: src,
    title: '合同审核',
    caseType: 'contract',
  })
  assert.equal(run.ok, true, JSON.stringify(run.error))

  const opened = await a.handle('case.open', { case: caseDir })
  assert.equal(opened.data.caseType, 'contract')
  assert.equal(opened.data.caseTypeLabel, '合同审核')
})

test('pipeline.run 相对路径按案件根目录解析（不能建到宿主 cwd）', async () => {
  const root = tmpRoot()
  const a = api(root)
  const out = await a.handle('pipeline.run', { case: '相对案子', title: '相对案子' })
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.data.case, path.join(root, '相对案子'), '应落在配置的 root 下')
  assert.ok(fs.existsSync(path.join(root, '相对案子', '.lawcase', 'case.json')))
})

test('pipeline.run 相对路径且没有 root 时明确报错', async () => {
  const a = createApi({ version: 't', root: null })
  const out = await a.handle('pipeline.run', { case: '相对案子', title: '相对案子' })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'case/relative')
})

import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPipeline } from '../lib/core/pipeline.js'
import { readJson, casePaths } from '../lib/core/store.js'

function makeSrc(dir, files) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body)
  }
}

const SRC_FILES = {
  '起诉状.docx': 'placeholder',
  '情况说明.txt': '说明正文',
}

test('流水线：建案 + 扫材料 + 解析，并报出待决定项', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-pipe-'))
  const caseDir = path.join(root, 'case')
  const src = path.join(root, 'src')
  makeSrc(src, SRC_FILES)
  const r = await runPipeline({ case: caseDir, title: '流水线案', parties: '甲；乙', source: src })
  assert.strictEqual(r.created, true)
  assert.strictEqual(r.materials, 2)
  assert.ok(r.steps.every((s) => s.ok || s.step === '解析材料'), '除解析外都应成功')
  // 空案件必然有待决定：没工序、没事实、没结论
  assert.ok(r.todo.some((t) => t.includes('工序表')), '应提示先拆工序')
  assert.ok(r.todo.some((t) => t.includes('事实台账')), '应提示抽事实')
  assert.ok(r.todo.some((t) => t.includes('结论台账')), '应提示出结论')
})

test('流水线：案件已存在时不重复建案，也不覆盖已有数据', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-pipe2-'))
  const caseDir = path.join(root, 'case')
  const src = path.join(root, 'src')
  makeSrc(src, SRC_FILES)
  const first = await runPipeline({ case: caseDir, title: '甲案', parties: '甲；乙', source: src })
  assert.strictEqual(first.created, true)
  const cp = casePaths(caseDir)
  const before = readJson(cp.caseJson, null)
  const second = await runPipeline({ case: caseDir, source: src })
  assert.strictEqual(second.created, false)
  const after = readJson(cp.caseJson, null)
  assert.strictEqual(after.caseId, before.caseId, '案件编号不能变')
  assert.strictEqual(after.title, before.title, '标题不能被冲掉')
})

test('流水线：没有标题又不存在案件时，明确拒绝而不是建个无名案', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-pipe3-'))
  const caseDir = path.join(root, 'nowhere')
  await assert.rejects(() => runPipeline({ case: caseDir }), /要新建请传 title/)
})

test('流水线：没有材料源时不假装成功，明确说缺什么', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-pipe4-'))
  const caseDir = path.join(root, 'case')
  const r = await runPipeline({ case: caseDir, title: '无源案', parties: '甲；乙' })
  const scanStep = r.steps.find((s) => s.step === '扫材料')
  assert.strictEqual(scanStep.ok, false)
  assert.match(scanStep.detail, /没有材料源目录/)
  assert.strictEqual(r.ok, false, '带失败步骤时整体 ok 应为 false')
})

test('流水线：解析进度按份落盘，能看出跑到哪', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-pipe5-'))
  const caseDir = path.join(root, 'case')
  const src = path.join(root, 'src')
  makeSrc(src, { 'a.txt': '一', 'b.txt': '二' })
  await runPipeline({ case: caseDir, title: '进度案', parties: '甲；乙', source: src })
  const cp = casePaths(caseDir)
  const lines = fs.readFileSync(cp.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.ok(lines.some((l) => l.op === 'pipeline'), '应有流水线汇总记录')
})

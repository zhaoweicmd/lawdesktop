// 验收与核对的口径必须一致：
//   checkoff 说核完了，验收就不能再报「未复核」。
// 曾经的 bug：验收读 f.verified（checkoff 从不写这个字段），
// 于是面板核到 100%、验收仍报「事实 XX 未复核」，两个界面互相打脸。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { addFact } from '../lib/core/fact.js'
import { checkItem } from '../lib/core/checkoff.js'
import { verifyCase } from '../lib/core/verify.js'

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-vck-'))
  const dir = path.join(root, '案')
  const src = path.join(root, 'src')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'a.pdf'), 'x')
  newCase({ dir, title: '验收核对一致性', materialsDirs: [src] })
  scanMaterials({ case: dir, source: src })
  addFact({ case: dir, text: '被告收取货款五十万元后未交付货物', source: path.join(src, 'a.pdf'), locator: 'P1' })
  return { root, dir }
}

const factsCheck = (dir) => verifyCase({ case: dir }).checks.find((c) => c.name === 'facts')

test('没核对 → 事实道 warn，且提示去点「已核」', () => {
  const { root, dir } = mk()
  const c = factsCheck(dir)
  assert.equal(c.status, 'warn')
  assert.ok(c.items.some((i) => /还没有人工核对/.test(i.msg)))
  fs.rmSync(root, { recursive: true, force: true })
})

test('核完之后 → 事实道 pass（不再报未复核）', () => {
  const { root, dir } = mk()
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '张律师' })
  const c = factsCheck(dir)
  assert.equal(c.status, 'pass', JSON.stringify(c.items))
  assert.ok(!c.items.some((i) => /未复核|还没有人工核对/.test(i.msg)))
  fs.rmSync(root, { recursive: true, force: true })
})

test('标了「有疑问」不算已核对：仍要提示', () => {
  const { root, dir } = mk()
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'doubt', by: '张律师', note: '出处页码看不清' })
  const c = factsCheck(dir)
  assert.ok(c.items.some((i) => /还没有人工核对/.test(i.msg)), '「有疑问」不等于核对通过')
  fs.rmSync(root, { recursive: true, force: true })
})

test('未核对只是 warn，不进 mustFix、不拦交付', () => {
  const { root, dir } = mk()
  const r = verifyCase({ case: dir })
  assert.equal(r.mustFix.some((m) => /核对|复核/.test(m.msg)), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('来源失效（verified=broken）仍然判 fail——这是另一件事，不能被核对掩盖', () => {
  const { root, dir } = mk()
  const cpFacts = path.join(dir, '.lawcase', 'facts.jsonl')
  fs.appendFileSync(cpFacts, JSON.stringify({ id: 'F1', verified: 'broken', at: new Date().toISOString() }) + '\n')
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '张律师' })
  const c = factsCheck(dir)
  assert.equal(c.status, 'fail', '来源失效就是 fail，核对了也改不了这个事实')
  fs.rmSync(root, { recursive: true, force: true })
})

// ---- 定位写错 vs 引文造假：必须分开判 ----

import { checkQuote } from '../lib/core/parse.js'

const PDF = {
  units: [
    { n: 1, page: 1, text: '第一页开头' },
    { n: 17, page: 1, text: '1/6号到虹口区柳营路125号5楼，签了一张结算单总欠款11480584.4元' },
    { n: 240, page: 17, text: '第17页的内容' },
  ],
}

test('引文在文件里但位置写错 → misplaced（不是造假）', () => {
  const r = checkQuote(PDF, 'P17', '1/6号到虹口区柳营路125号5楼，签了一张结算单总欠款11480584.4元')
  assert.notEqual(r.verdict, 'broken', '位置错不该判成引文造假')
  assert.equal(r.verdict, 'misplaced')
  assert.equal(r.n, 17)
  assert.match(r.why, /想写段号|第 17 段/)
})

test('引文全文都没有 → broken（这一条才是真问题）', () => {
  const r = checkQuote(PDF, 'P17', '这句完全是编造的，文件里绝对没有')
  assert.equal(r.verdict, 'broken')
})

test('位置正确 → ok，不多做判断', () => {
  const r = checkQuote(PDF, '第17页', '第17页的内容')
  assert.equal(r.verdict, 'ok')
})

test('OCR 乱码页：判 ocr-poor（需人工看原图），不判事实造假', () => {
  const garbled = {
    units: [
      { n: 1, page: 1, text: '这一页识别正常，内容清楚可用' },
      // 真实乱码样本：数字/符号占绝大多数，汉字比例极低（与 M8 第 27 页同型）
      { n: 30, page: 3, text: 'TO:91320509MA26L4GA57 / 519678452018 / 11480584.4 | 2024-10-23 | 500 | 3.8 | 1926.6 | 10078368 | 10088191 | 9823 | 30476 | 222474.8 | RY240201D | 9028 | 22.4 | 202227.2 | 519/520/359/611' },
    ],
    pages: 3,
  }
  const r = checkQuote(garbled, '第3页', '这是一句原文引用内容')
  assert.equal(r.verdict, 'ocr-poor', '乱码页不能断言引文造假')
  assert.match(r.why, /识别质量差|乱码/)
  // 措辞要落在「机器比对不了」上，不能像在指责用户没核对
  assert.match(r.why, /机器无法比对|不是事实本身有问题/)
  assert.ok(!/需人工核对原图/.test(r.why), '已核对过的人不该再被要求核对原图')
})

test('验收项用 msg 字段渲染，不能把 JSON 原串怼到界面', () => {
  // 直接验证 core 产出的是 msg 字段（界面依赖它）
  const { root, dir } = mk()
  const r = verifyCase({ case: dir })
  const f = r.checks.find((c) => c.name === 'facts')
  assert.ok(f.items.length > 0)
  for (const it of f.items) {
    assert.equal(typeof it.msg, 'string', '验收项必须有可读的 msg 字段')
    assert.ok(it.msg.length > 0)
  }
  fs.rmSync(root, { recursive: true, force: true })
})

test('事实道分清「未核对」与「出处问题」，两个数字分开报', () => {
  const { root, dir } = mk()
  // 没核对 → unchecked
  let f = factsCheck(dir)
  assert.ok(f.counts, '事实道要带 counts')
  assert.equal(f.counts.unchecked, 1)
  assert.equal(f.counts.sourceIssues, 0)

  // 核对掉，但出处缺引文 → sourceIssues
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '测试' })
  f = factsCheck(dir)
  assert.equal(f.counts.unchecked, 0, '核完之后不该再算未核对')
  fs.rmSync(root, { recursive: true, force: true })
})

test('ui-state：只写 lastCase 不能把 root 抹掉', async () => {
  const fsx = await import('node:fs')
  const osx = await import('node:os')
  const pathx = await import('node:path')
  const { createApi } = await import('../lib/server/api.js')
  const pkgRoot = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'lawcase-uist-'))
  const api = createApi({ version: 't', root: '/cases', pkgRoot })
  await api.handle('ui.state.set', { root: '/my/cases' })
  await api.handle('ui.state.set', { lastCase: '/my/cases/A' })
  await api.handle('ui.state.set', { checker: '张三' })
  const raw = JSON.parse(fsx.readFileSync(pathx.join(pkgRoot, '.lawcase-plugin', 'ui-state.json'), 'utf8'))
  assert.equal(raw.root, '/my/cases', 'root 不能被后续的局部写入抹掉')
  assert.equal(raw.lastCase, '/my/cases/A')
  assert.equal(raw.checker, '张三')
  fsx.rmSync(pkgRoot, { recursive: true, force: true })
})

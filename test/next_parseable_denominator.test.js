// 真机教训（2026-11-01 用户实测）：
//   卷宗 32 份里混了 1 份 .zip（企业档案），界面卡点行永远显示「还有 1 份没解析」，
//   点多少次「批量解析」都不变，真正该做的工序/事实被挤到 alsoTodo 里。
//
// 根因不是解析坏了，是**分母错了**：parseAll 按 PARSABLE 白名单过滤，zip 永远不解析；
// 而 nextStep 拿「材料总数」当分母，于是分子永远追不上分母。
//
// 这组测试锁三件事：
//   1. 只有不可解析文件没处理时，不许再报「没解析」
//   2. 真的还有可解析文件没解析时，仍然要报（不能修过头变成永远不提示）
//   3. state 里 parseable/unparseable 分开给，界面才不会显示成「31/32」

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { nextStep } from '../lib/core/next.js'
import { casePaths, writeJsonAtomic } from '../lib/core/store.js'

function setup({ unparseable = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-parseable-'))
  const src = path.join(root, '卷宗')
  fs.mkdirSync(src, { recursive: true })
  // 两份可解析（txt 就在白名单里，不用造 docx 也能测分母）
  fs.writeFileSync(path.join(src, 'a.txt'), '第一份材料\n')
  fs.writeFileSync(path.join(src, 'b.txt'), '第二份材料\n')
  for (let i = 0; i < unparseable; i += 1) {
    fs.writeFileSync(path.join(src, `附件${i}.zip`), 'PK not really a zip')
  }
  const A = path.join(root, '案')
  newCase({ dir: A, title: '案', caseType: 'litigation', materialsDirs: [src] })
  const scan = scanMaterials({ case: A, source: src })
  return { A, src, scan }
}

/** 直接写解析缓存：parse 的缓存结构是 cache/parse/<mid>.json */
function fakeParsed(caseDir, mids) {
  const cp = casePaths(caseDir)
  const dir = path.join(cp.state, 'cache', 'parse')
  fs.mkdirSync(dir, { recursive: true })
  for (const mid of mids) {
    fs.writeFileSync(path.join(dir, `${mid}.json`), JSON.stringify({ units: [] }))
  }
}

const stuckTexts = (r) => [r.next, ...(r.alsoTodo || [])].filter(Boolean).map((x) => x.stuck || '')

test('不可解析文件（zip）不该让「还有 N 份没解析」永远挂着', () => {
  const { A, scan } = setup({ unparseable: 1 })
  const mids = scan.files.map((f) => f.mid)
  fakeParsed(A, mids)

  const r = nextStep({ case: A })
  assert.equal(
    stuckTexts(r).some((s) => /没解析/.test(s)),
    false,
    '可解析的都解析完了，就不能再提示"没解析"（zip 永远解析不了）'
  )
  // state 里要能看出"有一份是压根不打算解析的"
  assert.equal(r.state.unparseable, 1)
  assert.equal(r.state.parseable, 2)
  assert.equal(r.state.parsed, 2)
})

test('真还有可解析文件没解析时必须继续提示（不能修过头）', () => {
  const { A, scan } = setup({ unparseable: 1 })
  // 只解析第一份，第二份故意不写缓存
  fakeParsed(A, [scan.files[0].mid])

  const r = nextStep({ case: A })
  const hit = stuckTexts(r).find((s) => /没解析/.test(s))
  assert.ok(hit, '确实有 txt 没解析，必须提示')
  assert.equal(hit, '还有 1 份没解析', '分母是 2 份可解析的，不是 3 份总数')
})

test('缓存里残留已移出材料的旧条目时，parsed 不会超过分母', () => {
  const { A, scan } = setup({ unparseable: 1 })
  // 多写一条不存在于材料台账的缓存（现实中：文件被移走后缓存没清）
  fakeParsed(A, [...scan.files.map((f) => f.mid), 'M99'])

  const r = nextStep({ case: A })
  assert.equal(r.state.parsed, r.state.parseable, 'parsed 要按可解析份数封顶')
  assert.equal(
    stuckTexts(r).some((s) => /没解析/.test(s)),
    false,
    '旧缓存残留不能反过来制造"没解析"的假象'
  )
})

test('全部解析完成后，下一步应指向真正的工作（诉讼线：工序/事实）', () => {
  const { A, scan } = setup({ unparseable: 1 })
  fakeParsed(A, scan.files.map((f) => f.mid))

  const r = nextStep({ case: A })
  assert.ok(r.next, '应该给出下一步')
  assert.ok(
    /工序|事实|核对/.test(r.next.tool + r.next.stuck),
    `下一步不该再是解析，实际是 ${r.next.tool}：${r.next.stuck}`
  )
})

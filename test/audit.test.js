// 写入审计（机制 M1）：案件侧留证据，插件侧留可查的操作流水。
//
// 实证背景（2026-10-31）：plugin.log.jsonl 1464 行全是 client-mount 挂载记录，
// 零业务操作 ⇒ 谁改了哪条事实、谁把风险条款标成「无需审查」，插件层查不到。
//
// 这组测试的重点不是「能写」，是**反例**：
//   - 没接 sink 时必须**写不出来**（证明这条检查是真的，不是永远通过）
//   - 历史三参写法 log(dir,'op',{...}) 也必须同时进两处
//   - 摘要里的业务字段不许丢

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { addFact } from '../lib/core/fact.js'
import { log, setAuditSink, auditSink } from '../lib/core/store.js'
import {
  writeAudit, readAudit, lastAudit, pruneAudit, auditFile, auditDir, concise,
} from '../lib/core/audit.js'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-audit-'))
  const src = path.join(root, 'src')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'a.pdf'), 'x')
  const A = path.join(root, 'A案')
  newCase({ dir: A, title: 'A案', materialsDirs: [src] })
  scanMaterials({ case: A, source: src })
  return { root, src, A }
}

/** 接上审计落点，返回清理函数，避免测试之间互相污染 sink */
function withSink(pkgRoot) {
  setAuditSink(({ caseDir, record, previous }) => writeAudit({ pkgRoot, record, caseDir, previous }))
  return () => setAuditSink(null)
}

test('反例：没有接审计落点时，案件日志照写，但审计里必须一条都没有', () => {
  const { root, A } = setup()
  setAuditSink(null)
  addFact({ case: A, text: '合同签订于 2023 年 5 月', source: 'M1', locator: 'P1' })
  const rows = readAudit(root)
  assert.equal(rows.length, 0, '没接 sink 却写进了审计 ⇒ 这条检查是假的（说明某处绕过了 sink 直写）')
  // 案件侧不受影响：它才是对外证据
  const caseLog = fs.readFileSync(path.join(A, '.lawcase', 'log.jsonl'), 'utf8')
  assert.match(caseLog, /fact-add/)
})

test('接上 sink 后：一次事实登记，两处各多一行，且能对上号', () => {
  const { root, A } = setup()
  const done = withSink(root)
  try {
    const before = readAudit(root).length
    addFact({ case: A, text: '合同签订于 2023 年 5 月', source: 'M1', locator: 'P1' })
    const rows = readAudit(root)
    assert.equal(rows.length, before + 1)
    const r = rows[rows.length - 1]
    assert.equal(r.op, 'fact-add')
    assert.equal(r.case, 'A案', '审计要能看出是哪个案（只记目录名，不记绝对路径）')
    assert.ok(r.caseId, 'caseId 要带上，跨机对比靠它')
    assert.match(r.summary, /F1/)
  } finally {
    done()
  }
})

test('历史三参写法 log(dir, "op", {…}) 同样双写，且 op 不会被展开成字符索引', () => {
  const { root, A } = setup()
  const done = withSink(root)
  try {
    log(A, 'note-add', { id: 'N7', clause: '第五条', level: '重大风险' })
    const r = readAudit(root).pop()
    assert.equal(r.op, 'note-add')
    assert.doesNotMatch(JSON.stringify(r), /"0":"n"/, '字符串被当 record 展开就会出现按字符索引的垃圾')
    assert.match(r.summary, /N7/)
  } finally {
    done()
  }
})

test('lastAudit 跳过挂载类噪音，只回人的动作', () => {
  const { root, A } = setup()
  const day = new Date()
  writeAudit({ pkgRoot: root, record: { op: 'fact-add', id: 'F1' }, caseDir: A })
  writeAudit({ pkgRoot: root, record: { op: 'client-mount', phase: 'mount' }, caseDir: null })
  const last = lastAudit(root, { date: day })
  assert.ok(last)
  assert.equal(last.op, 'fact-add', '挂载日志把人挡住了 ⇒「上次动作」会一直显示「前端加载」')
})

test('lastAudit 跨天回溯：今天没有业务动作时去昨天找', () => {
  const { root, A } = setup()
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  writeAudit({ pkgRoot: root, record: { ts: yesterday.toISOString(), op: 'checkoff', kind: 'fact', id: 'F2' }, caseDir: A })
  const last = lastAudit(root, { withinDays: 3 })
  assert.ok(last, '只查今天 ⇒ 隔夜回来「上次动作」永远是空的')
  assert.equal(last.op, 'checkoff')
})

test('pruneAudit 只删过期的分片，保留窗口内的', () => {
  const { root } = setup()
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
  const fresh = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  for (const d of [old, fresh]) {
    const f = auditFile(root, d)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, '{"op":"x"}\n')
  }
  const n = pruneAudit(root, { keepDays: 30 })
  assert.equal(n, 1)
  const left = fs.readdirSync(auditDir(root))
  assert.equal(left.length, 1)
  assert.ok(left[0] !== path.basename(auditFile(root, old)))
})

test('审计里不出现案件的绝对路径（脱敏：插件日志会被备份/分享）', () => {
  const { root, A } = setup()
  const done = withSink(root)
  try {
    addFact({ case: A, text: '被告于 2024 年 1 月收到货物', source: 'M1', locator: 'P3' })
    const raw = fs.readFileSync(auditFile(root), 'utf8')
    assert.ok(!raw.includes(root), '审计落进了绝对路径 ⇒ 备份/发给别人等于泄露本机目录结构')
  } finally {
    done()
  }
})

test('concise 截断但不丢开头：审计记「做了什么」，不记全文', () => {
  const long = { text: 'x'.repeat(2000) }
  const s = concise(long, 100)
  assert.ok(s.length <= 101)
  assert.ok(s.startsWith('{"text":"xxx'))
})

test('审计失败不拖垮主流程：sink 抛错时业务仍然成功', () => {
  const { A } = setup()
  setAuditSink(() => {
    throw new Error('boom')
  })
  try {
    assert.doesNotThrow(() => {
      addFact({ case: A, text: '货物已于 2024 年 2 月交付', source: 'M1', locator: 'P5' })
    })
  } finally {
    setAuditSink(null)
  }
})

test('auditSink 可读回，便于自检与面板展示', () => {
  assert.equal(typeof auditSink, 'function')
  setAuditSink(() => true)
  assert.equal(typeof auditSink(), 'function')
  setAuditSink(null)
  assert.equal(auditSink(), null)
})

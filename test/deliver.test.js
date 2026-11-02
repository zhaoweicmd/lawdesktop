import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDelivery } from '../lib/core/deliver.js'
import { newCase } from '../lib/core/case.js'
import { addFact } from '../lib/core/fact.js'
import { planProcesses, updateProcess } from '../lib/core/proc.js'

/** 造一个"干净"的案件：有事实、有工序且都已完成、有报告 */
function cleanCase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-deliver-'))
  newCase({ dir, title: '交付测试案', cause: '测试', parties: '甲；乙' })
  // 放一份假报告到 out/（真实场景由 lc_report 生成）
  const matDir = path.join(dir, 'materials')
  fs.mkdirSync(matDir, { recursive: true })
  const src = path.join(matDir, '情况说明.txt')
  fs.writeFileSync(src, '甲方于2025年3月1日向乙方支付定金人民币五十万元整。\n', 'utf8')
  addFact({ case: dir, text: '甲方于2025年3月1日向乙方支付定金五十万元', source: src, locator: '第1段', confirmed: true })
  planProcesses({ case: dir, processes: [{ name: '登记事实', acceptance: '每条事实都有出处' }] })
  updateProcess({ case: dir, id: 'P1', status: 'done', acceptResult: true })
  const out = path.join(dir, 'out')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, '合同审核意见_20260101-0000.md'), '# 意见\n\n1. 付款条件应当明确。\n', 'utf8')
  return dir
}

test('验收未通过时拒绝出交付包，并把必须修项原文带出来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-deliver-bad-'))
  newCase({ dir, title: '空壳案', cause: '测试', parties: '甲；乙' })
  assert.throws(() => buildDelivery({ case: dir }), /验收未通过/)
  assert.throws(() => buildDelivery({ case: dir }), /事实台账为空/) // mustFix 原文
  assert.throws(() => buildDelivery({ case: dir }), /force=true/)
  // 拒绝时不应留下任何目录
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('交付包')).length, 0)
})

test('force=true 可强制生成；目录名只带时间戳，验收结论写在清单里', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-deliver-force-'))
  newCase({ dir, title: '空壳案', cause: '测试', parties: '甲；乙' })
  const r = buildDelivery({ case: dir, force: true })
  assert.match(r.base, /^交付包_\d{8}-\d{4}$/, '目录名不挂验收结论')
  assert.strictEqual(r.verdict, 'needs_fix', '真实结论在返回值里，不在目录名上')
  assert.ok(fs.existsSync(r.dir))
})

test('正常案件生成完整交付包：清单 + 机器清单 + 文件', () => {
  const dir = cleanCase()
  const r = buildDelivery({ case: dir, label: '致合伙人' })
  assert.match(r.base, /^交付包_\d{8}-\d{4}$/)
  assert.ok(fs.existsSync(path.join(r.dir, '交付清单.md')))
  assert.ok(fs.existsSync(path.join(r.dir, 'delivery.json')))
  assert.ok(r.files.length >= 3, `文件数应≥3，实际 ${r.files.length}`)

  const md = fs.readFileSync(path.join(r.dir, '交付清单.md'), 'utf8')
  assert.match(md, /致合伙人/)
  assert.match(md, /所有内容均为初稿/) // 必须提醒是初稿
  assert.match(md, /SHA256/)
  // 小节编号会因为「AI 审核与人工处理留痕」这一节的存在而顺延，
  // 所以断言看标题文字而不是「## 三」，否则加一节就把测试弄红（但功能是好的）
  assert.match(md, /## .*未包含的内容/) // 缺什么必须明写
  assert.match(md, /## .*复核提示/)
  // 没有 AI 审核/判定时也要说清，而不是留一个空节
  assert.match(md, /没有使用 AI 审核/)
  // 报告的正文要真的被复制过去
  const rep = r.files.find((f) => /意见/.test(f.name))
  assert.ok(rep, '应包含意见报告')
  assert.match(fs.readFileSync(path.join(r.dir, rep.name), 'utf8'), /付款条件应当明确/)
})

test('delivery.json 与磁盘文件一一对应，且 hash 可复核', () => {
  const dir = cleanCase()
  const r = buildDelivery({ case: dir })
  const m = JSON.parse(fs.readFileSync(path.join(r.dir, 'delivery.json'), 'utf8'))
  assert.ok(['pass', 'needs_review'].includes(m.verdict), `验收结论异常：${m.verdict}`)
  assert.equal(m.files.length, r.files.length)
  for (const f of m.files) {
    assert.ok(fs.existsSync(path.join(r.dir, f.name)), `文件应存在：${f.name}`)
    assert.match(f.sha256, /^[0-9a-f]{64}$/, `${f.name} 应有完整 sha256`)
  }
  // 清单里的短 hash 必须来自长 hash
  const md = fs.readFileSync(path.join(r.dir, '交付清单.md'), 'utf8')
  for (const f of m.files) assert.ok(md.includes(f.sha256.slice(0, 16)), `${f.name} 的短 hash 应在清单里`)
})

test('Word 临时锁文件（~$ 开头）不得进交付包', () => {
  const dir = cleanCase()
  const out = path.join(dir, 'out')
  fs.writeFileSync(path.join(out, '~$版_合同.docx'), 'lock', 'utf8')
  fs.writeFileSync(path.join(out, '修订版_合同.docx'), 'docx-bytes', 'utf8')
  const r = buildDelivery({ case: dir })
  assert.ok(r.files.some((f) => f.name.includes('修订版')))
  assert.ok(!r.files.some((f) => f.name.includes('~$')), '锁文件混进交付包了')
})

test('package.json 版本必须与 index.js 的 VERSION 一致（防止版本漂移）', async () => {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
  const src = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')
  const m = src.match(/const VERSION = '([^']+)'/)
  assert.ok(m, 'index.js 里应有 VERSION 常量')
  assert.equal(pkg.version, m[1], 'package.json 与 index.js 的 VERSION 不一致')
})

test('交付包：判定要按类型分开——「需修改」不能混进「无需修改」表', async () => {
  const os = await import('node:os')
  const { writeZip } = await import('../lib/core/zipwrite.js')
  const { newCase } = await import('../lib/core/case.js')
  const { scanMaterials } = await import('../lib/core/material.js')
  const { indexClauses, addNote, ruleClause } = await import('../lib/core/clause.js')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-deliv-kinds-'))
  const mat = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-deliv-kinds-mat-'))
  newCase({ dir, title: '判定分类测试', caseType: 'contract' })
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>第一条 甲方应在验收合格后十日内支付服务费人民币十万元。</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>第二条 双方应对商业秘密承担保密义务，期限为三年，期满后继续有效。</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  fs.writeFileSync(path.join(mat, '合同.docx'), writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: doc },
  ]))
  scanMaterials({ case: dir, source: mat })
  indexClauses({ case: dir, file: '合同.docx' })

  const file = '合同.docx'
  // 第一条：需修改（登记意见 + revision 判定）
  addNote({
    case: dir,
    file,
    clause: '第一条',
    level: '建议修改',
    issue: '付款未设逾期违约金，卖方拖延验收时价款无从主张，权利救济不足。',
    fix: '甲方应在验收合格后十日内支付；逾期付款的，每逾期一日按未付金额万分之五支付违约金。',
  })
  ruleClause({ case: dir, file, clause: '第一条', kind: 'revision', reason: '按意见修改' })
  // 第二条：无需修改
  ruleClause({ case: dir, file, clause: '第二条', kind: 'norevision', reason: '保密期限已明确且含期满后继续有效' })

  const r = buildDelivery({ case: dir, force: true })
  const md = fs.readFileSync(path.join(r.dir, '交付清单.md'), 'utf8')

  const norevSec = md.slice(md.indexOf('已审·无需修改'))
  assert.match(norevSec, /第二条/, '无需修改表里要有第二条')
  // 「第一条」是需修改，绝不能出现在无需修改表里
  const tablePart = norevSec.slice(0, norevSec.indexOf('\n\n'))
  assert.doesNotMatch(tablePart, /第一条/, '需修改的条款不能混进无需修改表')

  const m = JSON.parse(fs.readFileSync(path.join(r.dir, 'delivery.json'), 'utf8'))
  assert.equal(m.rulings.length, 1)
  assert.equal(m.rulings[0].clause, '第二条')
  assert.equal(m.revisions.length, 1)
  assert.equal(m.revisions[0].clause, '第一条')
})

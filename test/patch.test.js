// 片段级修订：唯一性、重叠、整批拒绝、原件只读、导出只含已接受修改。
//
// 这一组全是"会毁合同"的场景，所以断言比别处更硬：
//   · original 出现 0 次 / ≥2 次 → 整批拒绝
//   · 区间重叠 → 整批拒绝
//   · 任一处不合格 → 一处都不应用（不允许"改了一半"的合同）
//   · 原合同字节不变
//   · 新增段落最多一处

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writeZip } from '../lib/core/zipwrite.js'
import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { indexClauses } from '../lib/core/clause.js'
import { countOccurrences, validatePatches, applyPatchesToText } from '../lib/core/patch.js'
import { previewPatches, applyPatches, loadPatchRecord } from '../lib/core/patchrevise.js'

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lawcase-patch-${tag}-`))
}

function makeDocx(file, paras) {
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paras.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('') +
    '</w:body></w:document>'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: doc },
  ]))
  return file
}

const P1 = '第一条 本合同项下服务费为人民币十万元，甲方应于合同签订后三日内一次性支付全部款项。'
const P2 = '第二条 乙方应于甲方付款后交付成果，交付标准由双方另行确定。'
const P3 = '第三条 乙方应在三十日内完成，乙方应在三十日内交付。' // 故意重复「乙方应在三十日内」
const P4 = '第四条 双方应对合作中知悉的商业秘密承担保密义务，期限为一年。'

function contractCase(tag = 'c') {
  const dir = tmpDir(tag)
  const mat = tmpDir(tag + '-mat')
  newCase({ dir, title: '片段修订测试合同', caseType: 'contract', cause: '服务合同' })
  makeDocx(path.join(mat, '服务合同.docx'), [P1, P2, P3, P4])
  scanMaterials({ case: dir, source: mat })
  indexClauses({ case: dir, file: '服务合同.docx' })
  return { dir, mat, file: '服务合同.docx' }
}

function clues(dir) {
  // 直接从索引里取，保证和插件看到的是同一份条款
  const store = JSON.parse(fs.readFileSync(path.join(dir, '.lawcase', 'clauses.json'), 'utf8'))
  return store.files[0].clauses
}

// ============================================================================
// 计数与唯一性
// ============================================================================

test('countOccurrences：不重叠计数，两次以上就提前返回', () => {
  assert.equal(countOccurrences('abcabc', 'abc'), 2)
  assert.equal(countOccurrences('aaaa', 'aa'), 2)
  assert.equal(countOccurrences('abc', ''), 0)
  assert.equal(countOccurrences(null, 'x'), 0)
})

test('校验：唯一命中才接受', () => {
  const { dir } = contractCase('uniq')
  const v = validatePatches({
    clauses: clues(dir),
    patches: [{ clause: '第二条', original: '交付标准由双方另行确定', replacement: '交付标准以附件一为准' }],
  })
  assert.equal(v.ok, true, v.message)
  assert.equal(v.accepted.length, 1)
  assert.ok(v.accepted[0].start > 0)
})

test('校验：original 找不到 → 整批拒绝，并指出它其实在哪一条', () => {
  const { dir } = contractCase('notfound')
  const v = validatePatches({
    clauses: clues(dir),
    patches: [{ clause: '第二条', original: '交付标准由第三方机构认定为准', replacement: '不管' }],
  })
  assert.equal(v.ok, false)
  assert.match(v.message, /找不到/)
})

test('校验：引文抄错条款时，提示它在哪一条出现（条款错配）', () => {
  const { dir } = contractCase('mismatch')
  const v = validatePatches({
    clauses: clues(dir),
    patches: [{ clause: '第二条', original: '甲方应于合同签订后三日内一次性支付全部款项', replacement: '甲方应分期支付' }],
  })
  assert.equal(v.ok, false)
  assert.match(v.message, /第一条/, '要指出真正的归属条款')
  assert.match(v.message, /条款错配/)
})

test('校验：original 出现两次 → 不唯一，拒绝', () => {
  const { dir } = contractCase('dup')
  const v = validatePatches({
    clauses: clues(dir),
    patches: [{ clause: '第三条', original: '乙方应在三十日内', replacement: '乙方应在十五日内' }],
  })
  assert.equal(v.ok, false)
  assert.match(v.message, /不止一次|唯一/)
})

test('校验：original 太短不唯一定位 → 拒绝', () => {
  const { dir } = contractCase('short')
  const v = validatePatches({ clauses: clues(dir), patches: [{ clause: '第一条', original: '甲方', replacement: '乙方' }] })
  assert.equal(v.ok, false)
  assert.match(v.message, /不足|无法唯一定位/)
})

// ============================================================================
// 重叠与整批拒绝
// ============================================================================

test('校验：同一批里区间重叠 → 整批拒绝', () => {
  const { dir } = contractCase('overlap')
  const c = clues(dir).find((x) => x.text.includes('服务费为人民币十万元'))
  assert.ok(c)
  const v = validatePatches({
    clauses: clues(dir),
    patches: [
      { clause: c.no, original: '服务费为人民币十万元', replacement: '服务费为人民币二十万元' },
      // 与前一处重叠：都覆盖了「人民币十万元」
      { clause: c.no, original: '人民币十万元，甲方', replacement: '人民币三十万元，甲方' },
    ],
  })
  assert.equal(v.ok, false)
  assert.equal(v.code, 'patch/overlap')
  assert.match(v.message, /重叠/)
})

test('校验：任一处不合格 → 整批不应用（不允许改了一半）', () => {
  const { dir } = contractCase('partial')
  const v = validatePatches({
    clauses: clues(dir),
    patches: [
      { clause: '第二条', original: '交付标准由双方另行确定', replacement: '交付标准以附件一为准' },
      { clause: '第二条', original: '这句话根本不在合同里', replacement: '随便' },
    ],
  })
  assert.equal(v.ok, false)
  assert.equal(v.code, 'patch/partial-rejected')
  assert.equal(v.accepted.length, 0, '一处都不能落地')
})

test('校验：新增段落最多一处', () => {
  const { dir } = contractCase('add2')
  const v = validatePatches({
    clauses: clues(dir),
    patches: [
      { clause: '第一条', original: '', replacement: '新增：付款保函条款。' },
      { clause: '第二条', original: '', replacement: '新增：保密例外条款。' },
    ],
  })
  assert.equal(v.ok, false)
  assert.equal(v.code, 'patch/too-many-additions')
})

test('校验：空补丁 / 超过上限都拒绝', () => {
  const { dir } = contractCase('limits')
  assert.equal(validatePatches({ clauses: clues(dir), patches: [] }).code, 'patch/empty')
  const many = Array.from({ length: 201 }, () => ({ clause: '第一条', original: '一个字', replacement: 'x' }))
  assert.equal(validatePatches({ clauses: clues(dir), patches: many }).code, 'patch/too-many')
})

// ============================================================================
// 文本层模拟（对照预览用）
// ============================================================================

test('applyPatchesToText：只改那一段，其余原文不动', () => {
  const { dir } = contractCase('apply')
  const cs = clues(dir)
  const target = cs.find((c) => c.text.includes('交付标准由双方另行确定'))
  const r = applyPatchesToText({
    clauses: cs,
    patches: [{ clause: target.no, original: '交付标准由双方另行确定', replacement: '交付标准以附件一《交付标准》为准' }],
  })
  assert.equal(r.ok, true)
  const newText = r.texts[target.no]
  assert.match(newText, /附件一《交付标准》/)
  assert.doesNotMatch(newText, /交付标准由双方另行确定/)
  // 同条其余部分必须保留
  assert.match(newText, /乙方应于甲方付款后交付成果/)
})

test('applyPatchesToText：同一条款多处修改按偏移倒序，不会互相错位', () => {
  const clauses = [{ no: '第一条', text: 'AAA111 BBB222 CCC333' }]
  const r = applyPatchesToText({
    clauses,
    patches: [
      { clause: '第一条', original: 'AAA111', replacement: 'X' },
      { clause: '第一条', original: 'CCC333', replacement: 'Y' },
    ],
  })
  assert.equal(r.ok, true)
  assert.equal(r.texts['第一条'], 'X BBB222 Y')
})

test('applyPatchesToText：校验失败时不产出任何文本', () => {
  const { dir } = contractCase('applyfail')
  const r = applyPatchesToText({ clauses: clues(dir), patches: [{ clause: '第二条', original: '不存在的内容', replacement: 'x' }] })
  assert.equal(r.ok, false)
  assert.equal(r.texts, null)
})

// ============================================================================
// 落盘：原件只读 + 只含已接受修改
// ============================================================================

test('落盘：生成修订版 docx，原合同字节不变', async () => {
  const { dir, file } = contractCase('write')
  const cs = clues(dir)
  const target = cs.find((c) => c.text.includes('交付标准由双方另行确定'))
  const srcPath = path.join(dir, '..', '') // 占位，下面用索引里的真实路径
  const store = JSON.parse(fs.readFileSync(path.join(dir, '.lawcase', 'clauses.json'), 'utf8'))
  const src = store.files[0].file
  const before = fs.readFileSync(src)

  const r = await applyPatches({
    case: dir,
    file,
    patches: [{ clause: target.no, original: '交付标准由双方另行确定', replacement: '交付标准以附件一《交付标准》为准' }],
  })
  assert.equal(r.ok, true, r.message)
  assert.ok(fs.existsSync(r.outFile), '修订版要存在')

  const after = fs.readFileSync(src)
  assert.ok(before.equals(after), '原合同必须一字节未变')

  const rec = loadPatchRecord({ case: dir })
  assert.equal(rec.status, 'applied')
  assert.equal(rec.count, 1)
  assert.match(rec.accepted[0].original, /交付标准/)
})

test('落盘：校验失败时抛错，且不生成任何修订版文件', async () => {
  const { dir, file } = contractCase('writefail')
  const outDir = path.join(dir, 'out')
  const before = fs.existsSync(outDir) ? fs.readdirSync(outDir).length : 0
  await assert.rejects(
    () => applyPatches({ case: dir, file, patches: [{ clause: '第二条', original: '不在合同里的一句话', replacement: 'x' }] }),
    /找不到|整批/
  )
  const after = fs.existsSync(outDir) ? fs.readdirSync(outDir).length : 0
  assert.equal(after, before, '拒绝时不能留下任何产出文件')

  const rec = loadPatchRecord({ case: dir })
  assert.equal(rec.status, 'rejected', '拒绝也要留痕，否则说不清为什么没生成')
})

test('落盘：新增段落会追加到该条款，且计数正确', async () => {
  const { dir, file } = contractCase('writeadd')
  const r = await applyPatches({
    case: dir,
    file,
    patches: [{ clause: '第四条', original: '', replacement: '新增：本保密义务在本合同终止后继续有效。', reason: '强化保密' }],
  })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.additions.length, 1)
  const rec = loadPatchRecord({ case: dir })
  assert.equal(rec.additions.length, 1)
  assert.match(rec.additions[0].replacement, /继续有效/)
})

test('预览：只读，不写修订版也不改记录', async () => {
  const { dir, file } = contractCase('preview')
  const cs = clues(dir)
  const target = cs.find((c) => c.text.includes('交付标准由双方另行确定'))
  const before = loadPatchRecord({ case: dir }).status
  const p = previewPatches({
    case: dir,
    file,
    patches: [{ clause: target.no, original: '交付标准由双方另行确定', replacement: '交付标准以附件一为准' }],
  })
  assert.equal(p.ok, true, p.message)
  assert.equal(p.accepted.length, 1)
  assert.ok(Array.isArray(p.diff) && p.diff.length === 1)
  assert.equal(p.diff[0].before, '交付标准由双方另行确定')
  assert.equal(loadPatchRecord({ case: dir }).status, before, '预览不能改记录状态')
  assert.equal(fs.existsSync(path.join(dir, 'out')), false, '预览不能生成文件')
})

test('预览：校验失败直接返回 ok:false 与原因，不抛错（界面要能显示）', () => {
  const { dir, file } = contractCase('previewfail')
  const p = previewPatches({ case: dir, file, patches: [{ clause: '第二条', original: '不存在的内容呀', replacement: 'x' }] })
  assert.equal(p.ok, false)
  assert.match(p.message, /找不到|整批|不合格/)
})

test('落盘：修订版里条号只出现一次，且只有变化的那一段被划线', async () => {
  const { dir, file } = contractCase('docxmarkup')
  const cs = clues(dir)
  const target = cs.find((c) => c.text.includes('交付标准由双方另行确定'))
  const r = await applyPatches({
    case: dir,
    file,
    patches: [{ clause: target.no, original: '交付标准由双方另行确定', replacement: '交付标准以附件一为准' }],
  })
  assert.equal(r.ok, true, r.message)

  const { readZip } = await import('../lib/core/zip.js')
  const xml = readZip(fs.readFileSync(r.outFile)).readText('word/document.xml')
  const plain = xml.replace(/<[^>]+>/g, '')

  // 条号重复是最伤的：导出件会变成「第二条 …第二条 …」，直接是废稿
  const noHits = (plain.match(/第二条/g) || []).length
  assert.equal(noHits, 1, `条号只能出现一次，实际 ${noHits} 次：${plain.slice(0, 200)}`)

  // 只有变化的那一段被标删除线，前面的「乙方应于甲方付款后交付成果，」必须原样保留且不划线
  assert.match(xml, /<w:strike\/><w:color w:val="FF0000"\/><\/w:rPr><w:t xml:space="preserve">交付标准由双方另行确定<\/w:t>/)
  const untouched = xml.match(/<w:r><w:rPr><\/w:rPr><w:t xml:space="preserve">乙方应于甲方付款后交付成果，<\/w:t><\/w:r>/)
  assert.ok(untouched, '没动的部分不能被划掉')
  // 新文案是红色下划线
  assert.match(xml, /<w:u w:val="single"\/><\/w:rPr><w:t xml:space="preserve">交付标准以附件一为准<\/w:t>/)
})

test('落盘：修订版只包含已接受的修改——被拒绝的补丁不会出现在导出件里', async () => {
  const { dir, file } = contractCase('onlyaccepted')
  const cs = clues(dir)
  const target = cs.find((c) => c.text.includes('交付标准由双方另行确定'))

  // 先验证过一批「含不合格项」的补丁：整批被拒，不产出文件
  await assert.rejects(
    () =>
      applyPatches({
        case: dir,
        file,
        patches: [
          { clause: target.no, original: '交付标准由双方另行确定', replacement: '交付标准以附件一为准' },
          { clause: '第二条', original: '这段文字合同里没有', replacement: '小动作' },
        ],
      }),
    /整批|找不到/
  )
  assert.equal(fs.existsSync(path.join(dir, 'out')), false, '整批被拒时不能有产出')

  // 只提交合格的那一处：导出件里只有它
  const r = await applyPatches({
    case: dir,
    file,
    patches: [{ clause: target.no, original: '交付标准由双方另行确定', replacement: '交付标准以附件一为准' }],
  })
  const { readZip } = await import('../lib/core/zip.js')
  const plain = readZip(fs.readFileSync(r.outFile)).readText('word/document.xml').replace(/<[^>]+>/g, '')
  assert.match(plain, /交付标准以附件一为准/)
  assert.doesNotMatch(plain, /小动作/, '被拒绝的补丁不能出现在成品里')
})

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeZip } from '../lib/core/zipwrite.js'
import { readDocx } from '../lib/core/docx.js'
import { readZip } from '../lib/core/zip.js'
import { newCase } from '../lib/core/case.js'
import { indexClauses, addNote } from '../lib/core/clause.js'
import { reviseContract } from '../lib/core/redline.js'

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lawcase-${tag}-`))
}

/** 造一份最小 docx：两段正文，第一段是条款 */
function makeContract(file, paras) {
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paras
      .map(
        (t) =>
          `<w:p><w:pPr><w:spacing w:line="400"/></w:pPr><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
      )
      .join('') +
    '</w:body></w:document>'
  const buf = writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: doc },
  ])
  fs.writeFileSync(file, buf)
  return file
}

test('修订版：原文标红色删除线、新条文标红色下划线、XML 仍平衡', () => {
  const dir = tmpDir('rl')
  const caseDir = path.join(dir, 'case')
  newCase({ dir: caseDir, title: '测试案', parties: '甲；乙' })
  const contract = path.join(dir, '合同.docx')
  makeContract(contract, [
    '第一条  乙方应在收到材料后 7 日内完成设计。',
    '第二条  甲方应在验收合格后付款。',
  ])
  indexClauses({ case: caseDir, file: contract })
  addNote({
    case: caseDir,
    clause: '第一条',
    level: '建议修改',
    issue: '「收到材料后 7 日内」未约定材料迟延提供的后果，工期风险全由乙方承担。',
    fix: '乙方应在收到材料后 7 个工作日内完成设计；甲方迟延提供材料的，交付期限相应顺延。',
    apply: 'redline',
  })
  const r = reviseContract({ case: caseDir })
  assert.ok(r.ok)
  assert.deepStrictEqual(r.clauseList, ['第一条'])

  const buf = fs.readFileSync(r.file)
  const xml = readZip(buf).readText('word/document.xml')
  // 不用 Word 修订标记，改为静态格式：原文红色删除线、新文红色下划线
  assert.strictEqual((xml.match(/<w:ins /g) || []).length, 0, '不应再有 w:ins（会被 Word 塞进批注框）')
  assert.strictEqual((xml.match(/<w:del /g) || []).length, 0, '不应再有 w:del')
  assert.strictEqual((xml.match(/<w:strike\/>/g) || []).length, 1, '原文应有一条删除线')
  assert.strictEqual((xml.match(/<w:u w:val="single"\/>/g) || []).length, 1, '新文应有一条下划线')
  assert.strictEqual((xml.match(/<w:color w:val="FF0000"\/>/g) || []).length, 2, '删除与新文都标红')
  for (const tag of ['w:p', 'w:pPr', 'w:del', 'w:ins', 'w:r']) {
    const o = (xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g')) || []).length
    const c = (xml.match(new RegExp(`</${tag}>`, 'g')) || []).length
    assert.strictEqual(o, c, `${tag} 标签应平衡`)
  }
  // 删除段里不能残留 w:t（Word 会拒）
  // 删除线段落里的文字必须还是 w:t（不再换成 w:delText）
  assert.ok(/<w:strike\/>/.test(xml), '删除内容必须是带删除线的正常文本')
  // 读回：原文与新条文都在正文里
  const texts = readDocx(buf).map((p) => p.text).join('\n')
  assert.ok(texts.includes('7 个工作日内完成设计'), '新条文应可读')
  // 原文不再被删掉，而是留在正文里划删除线——这样任何软件打开都看得见
  assert.ok(texts.includes('收到材料后 7 日内完成设计'), '原文应保留在正文（带删除线），与示例文件一致')
  assert.ok(texts.includes('第二条'), '未涉及的条款应保持原样')
})

test('修订版：只落实指定意见', () => {
  const dir = tmpDir('rl2')
  const caseDir = path.join(dir, 'case')
  newCase({ dir: caseDir, title: '测试案2', parties: '甲；乙' })
  const contract = path.join(dir, '合同.docx')
  makeContract(contract, ['第一条  乙方完成设计。', '第二条  甲方付款。'])
  indexClauses({ case: caseDir, file: contract })
  const n1 = addNote({
    case: caseDir, clause: '第一条', level: '重大风险',
    issue: '没有约定完成时限，乙方履约无期限约束，甲方无法主张逾期责任。',
    fix: '第一条改为：乙方应于本合同生效后 30 日内完成设计并交付全部成果。',
    apply: 'redline',
  })
  addNote({
    case: caseDir, clause: '第二条', level: '建议修改',
    issue: '付款没有约定期限，甲方可以无限期拖延支付而不构成违约。',
    fix: '第二条改为：甲方应于收到发票后 15 个工作日内支付全部价款。',
    apply: 'redline',
  })
  const r = reviseContract({ case: caseDir, noteIds: [n1.note.id] })
  assert.strictEqual(r.notes, 1)
  assert.deepStrictEqual(r.clauseList, ['第一条'])
})

test('修订版：没有意见时拒绝产出空改稿', () => {
  const dir = tmpDir('rl3')
  const caseDir = path.join(dir, 'case')
  newCase({ dir: caseDir, title: '测试案3', parties: '甲' })
  const contract = path.join(dir, '合同.docx')
  makeContract(contract, ['第一条  内容。'])
  indexClauses({ case: caseDir, file: contract })
  assert.throws(() => reviseContract({ case: caseDir }), /没有可落实的审核意见/)
})

// 局部修改：意见只说「第4项改为…」时，不能把整条 14 段全删掉，其余段落必须原样保留
test('局部修改只换目标段，其余段落保留', async () => {
  const { parsePartial, cn2int, findPartialTarget } = await import('../lib/core/redline.js')
  assert.equal(cn2int('四'), 4)
  assert.equal(cn2int('十八'), 18)
  const parts = parsePartial('第一阶段第4项改为：修改以3轮为限。第二阶段改为：修改以2轮为限')
  assert.equal(parts.length, 2)
  assert.deepEqual(parts.map((p) => [p.num, p.unit]), [[4, '项'], [2, '阶段']])
  assert.match(parts[0].text, /修改以3轮为限/)
  const seg = [
    { text: '第三条  乙方应按下列进度完成服务工作：' },
    { text: '1.工业设计部分' },
    { text: '4.每次设计修改周期为 7 个工作日' },
    { text: '第二阶段：详细设计阶段' },
  ]
  assert.equal(findPartialTarget(seg, { num: 4, unit: '项' }), 2)
  assert.equal(findPartialTarget(seg, { num: 2, unit: '阶段' }), 3)
  assert.equal(findPartialTarget(seg, { num: 9, unit: '项' }), -1)
  // 没有「改为：」的说法不算局部修改，仍走整条替换
  assert.deepEqual(parsePartial('第三条整条重写为以下内容……'), [])
})

// ---------- 自动编号合同（真实合同的主流格式）----------
// 这一组钉住「Word 自动编号」这条链路：正文里没有「第X条」字样，序号在 numbering.xml 里。
// 以前 readDocx 只取文字，于是这类合同切出 0 条条款，条款页看着能用实际全废。

/** 造一份用自动编号的 docx：顶层 numId=1 是条款，附件用 numId=2 另一组列表 */
function makeNumberedContract(file) {
  const p = (text, numId, ilvl) =>
    `<w:p><w:pPr>${
      numId == null
        ? ''
        : `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`
    }</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    p('服务协议', null) +
    p('服务项目', 1, 0) +
    p('乙方提供居间服务。', 1, 1) +
    p('合作期限', 1, 0) +
    p('期限为三年。', 1, 1) +
    p('违约责任', 1, 0) +
    p('逾期按日千分之一计算违约金。', 1, 1) +
    p('附则', 1, 0) +
    p('附件清单甲', 2, 0) +
    p('附件清单乙', 2, 0) +
    '</w:body></w:document>'
  const numbering =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>' +
    '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/></w:lvl></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>' +
    '</w:numbering>'
  const buf = writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: doc },
    { name: 'word/numbering.xml', data: numbering },
  ])
  fs.writeFileSync(file, buf)
  return file
}

test('自动编号：readDocx 把序号还原成可见文字，且每条各自从 1 起算', () => {
  const dir = tmpDir('num')
  const f = makeNumberedContract(path.join(dir, '编号合同.docx'))
  const paras = readDocx(fs.readFileSync(f))
  const texts = paras.map((p) => p.text).filter(Boolean)
  assert.ok(texts.includes('1. 服务项目'), '顶层编号应还原成「1. 服务项目」: ' + JSON.stringify(texts))
  assert.ok(texts.includes('2. 合作期限'), '第二条应为 2.: ' + JSON.stringify(texts))
  assert.ok(texts.includes('1.1. 乙方提供居间服务。'), '款应还原成 1.1.: ' + JSON.stringify(texts))
  // 附件是另一组 numId，必须重新从 1 开始，不能接着正文数到 5、6
  assert.ok(texts.includes('1. 附件清单甲'), '附件列表应重新从 1 起: ' + JSON.stringify(texts))
})

test('自动编号：切条款只认正文那一组，附件的列表不算条', async () => {
  const dir = tmpDir('numsplit')
  const caseDir = path.join(dir, 'case')
  newCase({ dir: caseDir, title: '编号合同案', caseType: 'contract' })
  const f = makeNumberedContract(path.join(dir, '编号合同.docx'))
  const r = indexClauses({ case: caseDir, file: f })
  assert.equal(r.count, 4, '正文 4 条，附件列表不算: ' + JSON.stringify(r.clauses.map((c) => c.no)))
  assert.deepEqual(r.clauses.map((c) => c.no), ['1', '2', '3', '4'])
})

test('自动编号：条款号是阿拉伯数字时，修订版仍能定位并落实', async () => {
  const dir = tmpDir('numred')
  const caseDir = path.join(dir, 'case')
  newCase({ dir: caseDir, title: '编号合同案', caseType: 'contract' })
  const f = makeNumberedContract(path.join(dir, '编号合同.docx'))
  indexClauses({ case: caseDir, file: f })
  addNote({
    case: caseDir,
    file: '编号合同.docx',
    clause: '3',
    level: '重大风险',
    issue: '违约金按日千分之一计算，年化 36.5% 远超司法保护上限，且没有封顶约定。',
    fix: '逾期付款的，每逾期一日按未付金额的 0.03% 支付违约金，总额不超过该笔金额的 10%。',
    apply: 'redline',
  })
  const r = reviseContract({ case: caseDir })
  assert.ok(r.applied.length >= 1, '自动编号合同应能定位到第3条: ' + JSON.stringify(r.skipped))
  assert.equal(r.applied[0].clauseNo, 3)
})

test('作废意见必须真正消失：列表/报告/修订版/验收都不再读到它', async () => {
  const dir = tmpDir('delnote')
  const caseDir = path.join(dir, 'case')
  newCase({ dir: caseDir, title: '删除意见案', caseType: 'contract' })
  const contract = path.join(dir, '合同.docx')
  makeContract(contract, [
    '第一条  乙方应在收到材料后 7 日内完成设计。',
    '第二条  甲方应在验收合格后付款。',
  ])
  indexClauses({ case: caseDir, file: contract })
  const bad = addNote({
    case: caseDir,
    file: '合同.docx',
    clause: '第一条',
    level: '建议修改',
    issue: '付款与验收未挂钩，注意验收标准也不明确，容易扯皮说不清。',
    fix: '甲方应在验收合格后 10 个工作日内支付合同价款。',
  })
  const keep = addNote({
    case: caseDir,
    file: '合同.docx',
    clause: '第二条',
    level: '重大风险',
    issue: '只约定付款而不约定验收标准与期限，卖方交付即可主张全额价款，买方失去救济手段。',
    fix: '买方应在收货后 7 个工作日内按附件技术规格验收，逾期未提异议视为合格。',
  })
  const { listNotes, deleteNote, buildReport } = await import('../lib/core/clause.js')
  const { verifyCase } = await import('../lib/core/verify.js')
  assert.equal(listNotes({ case: caseDir }).count, 2)
  deleteNote({ case: caseDir, id: bad.note.id })
  // 台账是追加写：作废标记和原件并存，必须按 id 折叠，否则原件会把作废标记抵消掉
  const after = listNotes({ case: caseDir })
  assert.equal(after.count, 1, '作废后应只剩 1 条')
  assert.equal(after.notes[0].id, keep.note.id)
  assert.doesNotThrow(() => buildReport({ case: caseDir }))
  const v = verifyCase({ case: caseDir })
  const exec = v.checks.find((c) => c.title === '意见可执行')
  assert.ok(
    !(exec.items || []).some((it) => String(it.msg).includes('注意')),
    '作废意见里的空泛词不该继续让验收失败：' + JSON.stringify(exec.items)
  )
})

test('意见表：自动编号合同的「原文」是标题，不是". 服务费用"', async () => {
  const dir = tmpDir('rephead')
  const caseDir = path.join(dir, 'case')
  newCase({ dir: caseDir, title: '标题剥离案', caseType: 'contract' })
  const f = makeNumberedContract(path.join(dir, '编号合同.docx'))
  indexClauses({ case: caseDir, file: f })
  addNote({
    case: caseDir,
    file: '编号合同.docx',
    clause: '3',
    level: '重大风险',
    issue: '违约金按日千分之一计算，年化 36.5% 远超司法保护上限，且没有封顶约定。',
    fix: '逾期付款的，每逾期一日按未付金额的 0.03% 支付违约金，总额不超过该笔金额的 10%。',
    apply: 'redline',
  })
  const { buildReport } = await import('../lib/core/clause.js')
  const r = buildReport({ case: caseDir })
  const md = fs.readFileSync(r.file, 'utf8')
  assert.ok(md.includes('**原文**：违约责任'), '应剥掉数字编号只留标题：\n' + md.slice(0, 800))
  assert.ok(!/\*\*原文\*\*：\s*[.．、]/.test(md), '不能剩下孤零零的句点')
})

test('多段条款：用 AI 草稿出修订版时，其余段落必须原样保留（不能整条划掉）', async () => {
  // 真机踩过的严重问题：17 段的「服务费用」条款被整段划掉、只留一段新文，
  // 等于把合同改废。原因是用 AI 草稿走的是"整条重写"分支。
  const os = await import('node:os')
  const { newCase } = await import('../lib/core/case.js')
  const { writeZip } = await import('../lib/core/zipwrite.js')
  const { scanMaterials } = await import('../lib/core/material.js')
  const { indexClauses } = await import('../lib/core/clause.js')
  const { readZip } = await import('../lib/core/zip.js')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-multipara-'))
  const mat = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-multipara-mat-'))
  newCase({ dir, title: '多段条款测试', caseType: 'contract' })

  const paras = [
    '第四条 服务费用',
    '4.1 甲方应支付服务费用，以双方签署的确认书为结算依据。',
    '4.2 服务费款项包括居间报酬、校方管理费、差旅费。',
    '4.3 乙方应在每月十日前制作上月结算单。',
    '4.4 甲方收到结算单后两个工作日内核对，逾期视为无异议。',
    '4.5 乙方应在收到全部款项后三个工作日内开具发票。',
  ]
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paras.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('') +
    '</w:body></w:document>'
  fs.writeFileSync(path.join(mat, '合同.docx'), writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: doc },
  ]))
  scanMaterials({ case: dir, source: mat })
  indexClauses({ case: dir, file: '合同.docx' })

  // 塞一份 AI 草稿（只改 4.4 那句）
  const cp = path.join(dir, '.lawcase')
  fs.writeFileSync(
    path.join(cp, 'note-drafts.json'),
    JSON.stringify({
      file: '合同.docx',
      at: new Date().toISOString(),
      drafts: [
        {
          clause: '第四条',
          level: '建议修改',
          issue: '两个工作日核对期过短，甲方可能因未及时核对而视为认可全部费用。',
          fix: '甲方收到结算单后【5】个工作日内书面核对；逾期未确认不视为认可。',
          ok: true,
        },
      ],
    }),
    'utf8'
  )

  // 这条验的是"改正文时多段条款不能被整条划掉"，所以要显式要求改正文
  const out = reviseContract({ case: dir, source: 'drafts', draftsApply: 'redline', outName: '修订版_多段.docx' })
  assert.equal(out.ok, true, out.summary)
  assert.equal(out.applied[0].mode, 'insert', 'AI 草稿必须走 insert 模式，不能整条重写')

  const xml = readZip(fs.readFileSync(out.outFile)).readText('word/document.xml')
  const plain = xml.replace(/<[^>]+>/g, '')
  // 4.1–4.3、4.5 的原文必须还在
  assert.match(plain, /服务费款项包括居间报酬/, '4.2 原文不能丢')
  assert.match(plain, /乙方应在每月十日前制作上月结算单/, '4.3 原文不能丢')
  assert.match(plain, /开具发票/, '4.5 原文不能丢')
  // 新条文要在
  assert.match(plain, /甲方收到结算单后【5】个工作日内书面核对/)
  // 删除线不该铺满整条（只应有少量标记）
  const strikes = (xml.match(/<w:strike\/>/g) || []).length
  assert.ok(strikes <= 10, `删除线过多说明整条被划掉了：${strikes}`)
})

test('表格里的段落不算条款正文：整条替换不能切断表格结构（否则 Word 打不开）', async () => {
  // 真机事故：合同末尾用表格排附件，那些段落在自动编号里被计成第 13 条的一部分。
  // 整条替换时把 <w:tc> 的闭合顺序弄乱 → document.xml 不是合法 XML
  // → Word 报「在试图打开文件时遇到错误」。
  const os = await import('node:os')
  const { newCase } = await import('../lib/core/case.js')
  const { writeZip } = await import('../lib/core/zipwrite.js')
  const { scanMaterials } = await import('../lib/core/material.js')
  const { indexClauses } = await import('../lib/core/clause.js')
  const { readZip } = await import('../lib/core/zip.js')
  const { checkXmlBalanced } = await import('../lib/core/redline.js')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-tbl-'))
  const mat = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-tbl-mat-'))
  newCase({ dir, title: '表格条款测试', caseType: 'contract' })

  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document ${W}><w:body>` +
    '<w:p><w:r><w:t>第一条 甲方应在验收合格后十日内支付服务费十万元。</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>第二条 乙方应于收到付款后交付成果，标准以附件为准。</w:t></w:r></w:p>' +
    // 表格：附件里的费用明细（这些段落不能被当成条款正文）
    '<w:tbl><w:tr>' +
    '<w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>来程上限500元/人</w:t></w:r></w:p></w:tc>' +
    '</w:tr><w:tr>' +
    '<w:tc><w:p><w:r><w:t>备注</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>返程上限500元/人</w:t></w:r></w:p></w:tc>' +
    '</w:tr></w:tbl>' +
    '</w:body></w:document>'
  fs.writeFileSync(path.join(mat, '合同.docx'), writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: doc },
  ]))
  scanMaterials({ case: dir, source: mat })
  indexClauses({ case: dir, file: '合同.docx' })

  // 对"最后一条"做整条替换（最容易撞上表格）
  const store = JSON.parse(fs.readFileSync(path.join(dir, '.lawcase', 'clauses.json'), 'utf8'))
  const lastNo = store.files[0].clauses[store.files[0].clauses.length - 1].no
  const res = reviseContract({
    case: dir,
    file: '合同.docx',
    // 显式 apply:'redline'：这条测的是"改正文不能切断表格"
    edits: [{ clauseNo: lastNo, newText: '第二条 乙方应在收到付款后十日内交付成果，标准以附件一为准。', apply: 'redline' }],
    outName: '修订版_表格.docx',
  })
  assert.equal(res.ok, true, res.summary)

  const xml = readZip(fs.readFileSync(res.outFile)).readText('word/document.xml')
  // 1) 必须是合法 XML（这是 Word 能不能打开的根本）
  const bal = checkXmlBalanced(xml)
  assert.equal(bal.ok, true, 'XML 必须良构，否则 Word 打不开：' + (bal.reason || ''))
  // 2) 表格内容必须原样保留
  const plain = xml.replace(/<[^>]+>/g, '')
  assert.match(plain, /来程上限500元\/人/, '表格内容不能被改掉')
  assert.match(plain, /返程上限500元\/人/)
  assert.match(plain, /<w:tbl>|项目/, '表格结构要还在')
  assert.match(xml, /<w:tbl>/, '表格标签要保留')
  assert.match(xml, /<\/w:tbl>/, '表格闭合标签要保留')
})

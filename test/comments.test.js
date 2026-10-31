// 修改意见的批注输出（2.44.0）。
//
// 用户要求（2026-11-01）：「给实际修改意见增加一个批注功能，即将修改意见以批注的形式输出」。
// 口径：条款号 + 风险级别 + 问题 + 建议。
//
// 这组测试盯的是**Word 能不能打开**，不是"有没有生成文件"。
// OOXML 批注要四件套齐备，缺一个 Word 就报「内容无法读取」：
//   ① word/comments.xml ② Content_Types 注册 ③ document 关系 ④ 正文三个锚点标签

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'

import { reviseContract } from '../lib/core/redline.js'
import { readZip } from '../lib/core/zip.js'
import { buildCommentsXml, anchorComment, registerComments, commentTextFor } from '../lib/core/comments.js'

/** 造一份最小可用 docx（带 pPr，逼近真实合同的段落结构） */
function makeDocx(file, paras) {
  const body = paras
    .map(
      (p) =>
        `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="宋体" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`
    )
    .join('')
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'))
  fs.writeFileSync(path.join(tmp, '[Content_Types].xml'), ct)
  fs.mkdirSync(path.join(tmp, '_rels'))
  fs.writeFileSync(path.join(tmp, '_rels', '.rels'), rels)
  fs.mkdirSync(path.join(tmp, 'word'))
  fs.mkdirSync(path.join(tmp, 'word', '_rels'))
  fs.writeFileSync(path.join(tmp, 'word', 'document.xml'), doc)
  fs.writeFileSync(path.join(tmp, 'word', '_rels', 'document.xml.rels'), docRels)
  execFileSync('zip', ['-qr', path.resolve(file), '.'.toString()], { cwd: tmp })
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-cmt-'))
  const src = path.join(dir, '采购合同.docx')
  makeDocx(src, [
    '采购合同',
    '第一条 价款',
    '合同总价 100 万元，签订后 3 日内一次性付款。',
    '第二条 交货',
    '乙方应于收到订单后 7 个工作日内交货。',
  ])
  return { dir, src, out: path.join(dir, 'out.docx') }
}

const EDITS = [
  {
    clauseNo: 1,
    newText: '合同总价 100 万元，签订后 30 日内分期付款。',
    issue: '一次性付款对甲方现金流压力过大',
    level: '重大风险',
    basis: '行业惯例为分期付款',
  },
  {
    clauseNo: 2,
    newText: '乙方应于收到订单后 5 个工作日内交货。',
    issue: '交货期过长，影响甲方生产排期',
    level: '建议修改',
  },
]

test('★ 四件套齐备：comments.xml / Content_Types 注册 / document 关系 / 正文锚点', () => {
  const { src, out } = setup()
  reviseContract({ srcDocx: src, outDocx: out, edits: EDITS })
  const z = readZip(fs.readFileSync(out))
  const doc = z.readText('word/document.xml')
  const ct = z.readText('[Content_Types].xml')
  const rels = z.readText('word/_rels/document.xml.rels')

  assert.ok(z.has('word/comments.xml'), '缺 comments.xml ⇒ Word 报「内容无法读取」')
  assert.match(ct, /PartName="\/word\/comments\.xml"/, 'Content_Types 没注册 comments ⇒ Word 不认')
  assert.match(rels, /relationships\/comments/, 'document 关系缺失 ⇒ 批注框不出现在右栏')
  assert.equal((doc.match(/<w:commentRangeStart/g) || []).length, 2)
  assert.equal((doc.match(/<w:commentRangeEnd/g) || []).length, 2)
  assert.equal((doc.match(/<w:commentReference/g) || []).length, 2)
})

test('★ 批注数量与条款数一致（每条意见都要有批注，不能漏挂）', () => {
  const { src, out } = setup()
  const r = reviseContract({ srcDocx: src, outDocx: out, edits: EDITS })
  const z = readZip(fs.readFileSync(out))
  const com = z.readText('word/comments.xml')
  assert.equal((com.match(/<w:comment /g) || []).length, 2)
  assert.equal(r.comments.length, 2)
  // 三个 id 集合必须完全一致，错一个 Word 就会把批注挂错位置或丢弃
  const ids = new Set([...com.matchAll(/<w:comment w:id="(\d+)"/g)].map((m) => m[1]))
  const refs = new Set([...(z.readText('word/document.xml')).matchAll(/<w:commentReference w:id="(\d+)"/g)].map((m) => m[1]))
  assert.deepEqual([...ids].sort(), [...refs].sort())
})

test('批注正文含「条款号 + 风险级别 + 问题 + 建议」四件', () => {
  const text = commentTextFor({ clause: '第一条', level: '重大风险', issue: '付款方式过紧', fix: '改为分期', basis: '行业惯例' })
  assert.match(text, /第一条/)
  assert.match(text, /重大风险/)
  assert.match(text, /问题：付款方式过紧/)
  assert.match(text, /建议：改为分期/)
  assert.match(text, /依据：行业惯例/)
})

test('反例：没写 issue 也没有 fix 时不生成空批注（空框比没有更让人困惑）', () => {
  const { src, out } = setup()
  const r = reviseContract({ srcDocx: src, outDocx: out, edits: [{ clauseNo: 1, newText: '改了但没写理由。', apply: 'redline' }] })
  const z = readZip(fs.readFileSync(out))
  assert.equal(z.has('word/comments.xml'), false, '无话可说却造了个空批注框')
  assert.equal(r.comments.length, 0)
})

test('每条批注挂到**它自己那条**条款上（不能全部挂到第一条）', () => {
  const { src, out } = setup()
  // 用 redline：正文会变，锚点定位才是真正被考验的（纯批注模式下原文没动，容易蒙对）
  reviseContract({ srcDocx: src, outDocx: out, edits: EDITS.map((e) => ({ ...e, apply: 'redline' })) })
  const doc = readZip(fs.readFileSync(out)).readText('word/document.xml')
  // 取每个锚点所在的段落，看里面是不是对应条款的正文
  const anchorParas = []
  for (const m of doc.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    if (m[0].includes('commentRangeStart')) anchorParas.push(m[0])
  }
  assert.equal(anchorParas.length, 2)
  assert.ok(anchorParas[0].includes('30 日内') || anchorParas[0].includes('价款'), `第1条批注挂错：${anchorParas[0].slice(0, 80)}`)
  assert.ok(anchorParas[1].includes('5 个工作日') || anchorParas[1].includes('交货'), `第2条批注挂错：${anchorParas[1].slice(0, 80)}`)
})

test('生成的 docx 内部每个 XML 都是良构的（Word 比通用解析器严格）', () => {
  const { src, out } = setup()
  reviseContract({ srcDocx: src, outDocx: out, edits: EDITS })
  const buf = fs.readFileSync(out)
  const z = readZip(buf)
  for (const name of z.names()) {
    if (!/\.(xml|rels)$/.test(name)) continue
    const data = z.read(name)
    const s = data.toString('utf8')
    // 轻量良构检查：标签栈配对（与 redline.checkXmlBalanced 同一判据）
    const stack = []
    const re = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g
    let m
    let bad = ''
    while ((m = re.exec(s))) {
      if (m[1] === '/') {
        const top = stack.pop()
        if (top !== m[2]) { bad = `期望 </${top}> 实得 </${m[2]}>`; break }
      } else if (!m[4] && !m[0].startsWith('<?')) {
        stack.push(m[2])
      }
    }
    assert.equal(bad, '', `${name} 不良构：${bad}`)
    assert.equal(stack.length, 0, `${name} 有未闭合标签：${stack.join(',')}`)
  }
})

test('registerComments 幂等：重复注册不会造第二条关系', () => {
  const ct = '<Types>__X__</Types>'.replace('__X__', '')
  const rels = '<Relationships><Relationship Id="rId5" Type="x" Target="y"/></Relationships>'
  const once = registerComments({ contentTypes: ct, docRels: rels })
  const twice = registerComments({ contentTypes: once.contentTypes, docRels: once.docRels })
  assert.equal((twice.docRels.match(/relationships\/comments/g) || []).length, 1)
  assert.equal((twice.contentTypes.match(/\/word\/comments\.xml/g) || []).length, 1)
  // 新关系 id 不能撞已有的 rId5
  assert.match(twice.docRels, /Id="rId6"/)
})

test('anchorComment 单独可用：三个标签顺序正确', () => {
  const p = '<w:p><w:r><w:t>第一条 价款</w:t></w:r></w:p>'
  const out = anchorComment(p, { start: 0, end: p.length, id: 7 })
  const iStart = out.indexOf('<w:commentRangeStart w:id="7"/>')
  const iEnd = out.indexOf('<w:commentRangeEnd w:id="7"/>')
  const iRef = out.indexOf('<w:commentReference w:id="7"/>')
  assert.ok(iStart > -1 && iEnd > iStart && iRef > iEnd, '标签顺序错 ⇒ Word 会丢弃批注')
})

test('buildCommentsXml：多行正文用 w:br 而不是裸换行', () => {
  const xml = buildCommentsXml([{ id: 1, author: '测试', paras: ['第一行\n第二行'] }])
  assert.match(xml, /<w:br\/>/)
  assert.match(xml, /w:id="1"/)
  assert.doesNotMatch(xml, />第一行\n第二行</, '裸换行在 Word 里不换行')
})

test('comments:false 时退回纯红线（老行为不能被破坏）', () => {
  const { dir, src } = setup()
  const out = path.join(dir, 'plain.docx')
  const r = reviseContract({ srcDocx: src, outDocx: out, edits: EDITS.map((e) => ({ ...e, apply: 'redline' })), comments: false })
  const z = readZip(fs.readFileSync(out))
  assert.equal(z.has('word/comments.xml'), false)
  assert.equal(r.comments.length, 0)
  // 红线还在
  const doc = z.readText('word/document.xml')
  assert.match(doc, /<w:strike\/>/)
})

test('XML 特殊字符要转义（合同里常有 & < >）', () => {
  const xml = buildCommentsXml([{ id: 1, author: 'A&B', paras: ['价格 < 100 万 & 含税'] }])
  assert.match(xml, /&amp;/)
  assert.match(xml, /&lt;/)
  assert.doesNotMatch(xml, /价格 < 100/)
})

// ===== 2.45：按条款区分「批注」与「修订」 =====
//
// 用户口径（2026-11-01）：「有些条款是批注，有些条款是修订；用按钮做区别」。
// 默认必须是批注——替客户改正文属于越界，要改得显式点名。

test('★ 默认 apply=comment：正文一个字不动，只挂批注', () => {
  const { src, out } = setup()
  reviseContract({
    srcDocx: src,
    outDocx: out,
    edits: [{ clauseNo: 1, newText: '改成完全不同的一句话。', issue: '原约定对甲方不利', level: '重大风险' }],
  })
  const z = readZip(fs.readFileSync(out))
  const doc = z.readText('word/document.xml')
  const plain = doc.replace(/<[^>]+>/g, '')
  assert.match(plain, /签订后 3 日内一次性付款/, '默认模式下原文必须原样保留')
  assert.doesNotMatch(plain, /改成完全不同的一句话/, '默认模式下正文不能被改')
  assert.equal((doc.match(/<w:strike\/>/g) || []).length, 0, '默认模式不该出现删除线')
  assert.equal((z.readText('word/comments.xml').match(/<w:comment /g) || []).length, 1)
})

test('★ 混用：一条批注 + 一条修订，各走各的', () => {
  const { src, out } = setup()
  const r = reviseContract({
    srcDocx: src,
    outDocx: out,
    edits: [
      { clauseNo: 1, newText: '合同总价 100 万元，签订后 30 日内分期付款。', issue: '付款压力大', level: '重大风险', apply: 'comment' },
      { clauseNo: 2, newText: '乙方应于收到订单后 5 个工作日内交货。', issue: '交货期过长', level: '建议修改', apply: 'redline' },
    ],
  })
  const z = readZip(fs.readFileSync(out))
  const doc = z.readText('word/document.xml')
  const plain = doc.replace(/<[^>]+>/g, '')

  // 第一条：原文还在、新文不在正文里（只在批注里）
  assert.match(plain, /签订后 3 日内一次性付款/)
  assert.doesNotMatch(plain, /签订后 30 日内分期付款。/)
  // 第二条：原文被划掉、新文进了正文
  assert.match(plain, /5 个工作日内交货/)
  assert.ok((doc.match(/<w:strike\/>/g) || []).length > 0, '第二条应该有删除线')
  // 两条都挂了批注
  assert.equal((z.readText('word/comments.xml').match(/<w:comment /g) || []).length, 2)
  assert.equal(r.applied.length, 1, '只有 redline 那条算"落实了修订"')
  assert.equal(r.comments.length, 2, '两条都要有批注')
})

test('批注措辞：只批注写「建议改为」，改正文写「建议」', () => {
  const { src, out } = setup()
  const r = reviseContract({
    srcDocx: src,
    outDocx: out,
    edits: [
      { clauseNo: 1, newText: 'A 方案条文。', issue: '问题一', apply: 'comment' },
      { clauseNo: 2, newText: 'B 方案条文。', issue: '问题二', apply: 'redline' },
    ],
  })
  const c1 = r.comments.find((c) => c.clauseNo === 1)
  const c2 = r.comments.find((c) => c.clauseNo === 2)
  assert.match(c1.text, /建议改为：A 方案条文/, '正文没改，必须说清是"建议改为"')
  assert.match(c2.text, /建议：B 方案条文/, '正文已改，说"建议"即可')
})

test('全批注、零修订也是合法产物（不该报「没有可落实的意见」）', () => {
  const { src, out } = setup()
  const r = reviseContract({
    srcDocx: src,
    outDocx: out,
    edits: [{ clauseNo: 1, newText: '建议条文。', issue: '问题', apply: 'comment' }],
  })
  assert.equal(r.ok, true)
  assert.equal(r.applied.length, 0)
  assert.equal(r.comments.length, 1)
})

test('一条都落不了（既无修订也无批注）才报错', () => {
  const { src, out } = setup()
  assert.throws(
    () => reviseContract({ srcDocx: src, outDocx: out, edits: [{ clauseNo: 99, newText: '不存在条款', issue: '问题' }] }),
    /没有一条意见能定位/
  )
})

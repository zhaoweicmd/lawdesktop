import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readTxt, readDocText, findTextutil } from '../lib/core/doc.js'
import { PARSABLE } from '../lib/core/parse.js'

function tmp(fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-doc-'))
  try { return fn(d) } finally { fs.rmSync(d, { recursive: true, force: true }) }
}

test('.txt：UTF-8 正常解码，段落按行切', () => {
  const units = readTxt(Buffer.from('第一段\n第二段\n\n第三段', 'utf8'))
  assert.equal(units.length, 3)
  assert.equal(units[0].text, '第一段')
  assert.equal(units[2].text, '第三段')
})

test('.txt：UTF-8 BOM 不会污染首段', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('标题行', 'utf8')])
  assert.equal(readTxt(buf)[0].text, '标题行')
})

test('.txt：换页符 \\f 切页，页码递增', () => {
  const units = readTxt(Buffer.from('甲\n\f乙', 'utf8'))
  assert.equal(units.find((u) => u.text === '甲').page, 1)
  assert.equal(units.find((u) => u.text === '乙').page, 2)
})

test('.txt：空行被丢弃，不产生空段', () => {
  const units = readTxt(Buffer.from('\n\n\n有内容\n\n\n', 'utf8'))
  assert.equal(units.length, 1)
  assert.equal(units[0].text, '有内容')
})

test('PARSABLE 覆盖老格式与图片', () => {
  for (const ext of ['.doc', '.txt', '.rtf', '.png', '.jpg', '.jpeg']) {
    assert.ok(PARSABLE.has(ext), `${ext} 应可解析`)
  }
})

test('.doc：textutil 不存在时给出可照做的提示', async () => {
  if (findTextutil()) {
    await assert.rejects(
      () => readDocText('/nonexistent/x.doc'),
      /转换失败|不存在/,
    )
  } else {
    await assert.rejects(() => readDocText('/x.doc'), /缺少 \.doc 转换工具/)
  }
})

test('.doc：真实文件能读出段落（有样本时）', async () => {
  // 样本路径走环境变量：不要把任何一台机器的卷宗路径写进公开仓库
  const sample = process.env.LAWCASE_SAMPLE_DOC || ''
  if (!sample || !fs.existsSync(sample) || !findTextutil()) return
  const units = await readDocText(sample)
  assert.ok(units.length > 0, '应读出至少一段')
  assert.ok(units[0].text.length > 0, '首段不应为空')
})

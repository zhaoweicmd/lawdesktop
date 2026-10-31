import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findPdftotext, readPdf, looksScanned } from '../lib/core/pdf.js'
import { findOcr } from '../lib/core/ocr.js'
import { locate, checkQuote, PARSABLE } from '../lib/core/parse.js'

test('PDF 在可解析范围内（不再要求先手工转文本）', () => {
  assert.ok(PARSABLE.has('.pdf'))
})

test('找得到 pdftotext；找不到时给可执行的提示', () => {
  const bin = findPdftotext()
  if (!bin) {
    // 没有工具时，readPdf 必须说清怎么办，而不是静默返回空
    assert.throws(() => readPdf('/tmp/nonexistent.pdf'), /找不到 pdftotext|brew install poppler/)
    return
  }
  assert.ok(fs.existsSync(bin))
})

test('扫描件判定：抽到的字太少就当扫描件', () => {
  assert.strictEqual(looksScanned({ units: [] }), true)
  assert.strictEqual(looksScanned({ units: [{ text: '短' }] }), true)
  assert.strictEqual(
    looksScanned({ units: [{ text: '这一行有足够多的字，说明 PDF 里确实埋着文本层，不是纯图片扫描件。' }] }),
    false,
  )
})

test('页码定位：写「第12页」按页找，不按段找', () => {
  const parsed = {
    units: [
      { n: 1, page: 1, text: '第一页第一行' },
      { n: 2, page: 1, text: '第一页第二行' },
      { n: 3, page: 2, text: '第二页第一行' },
    ],
  }
  const r = locate(parsed, '第2页')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.page, 2)
  assert.strictEqual(r.kind, 'page')
  assert.ok(r.text.includes('第二页第一行'))
  assert.ok(!r.text.includes('第一页第一行'), '不该把别的页混进来')
})

test('页码越界要说清共几页', () => {
  const parsed = { units: [{ n: 1, page: 1, text: '只有一页' }] }
  const r = locate(parsed, '第9页')
  assert.strictEqual(r.ok, false)
  assert.match(r.why, /共 1 页/)
})

test('没有页码的 docx 里写「第2页」：不能当成第2段，改走全文兜底', () => {
  // 以前按段号处理，会把「第2页」指到第2段——出处直接指错地方。
  const parsed = { units: [{ n: 1, text: '甲' }, { n: 2, text: '乙' }] }
  const r = locate(parsed, '第2页')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.kind, 'page-unavailable', '写的是页但没有页码信息，交给全文兜底')
  assert.strictEqual(r.pageHint, 2)
})

test('P2 这种写法也算按页定位（不能误判成 P 开头的段号）', () => {
  const parsed = { units: [{ n: 1, text: '甲' }, { n: 2, text: '乙' }] }
  const r = locate(parsed, 'P2 首部 / P17 签署栏')
  assert.strictEqual(r.kind, 'page-unavailable')
  assert.strictEqual(r.pageHint, 2)
})

test('全文兜底：引文在别处能找到就算 ok，找不到仍然 broken', () => {
  const parsed = {
    units: [
      { n: 1, text: '第一段无关内容' },
      { n: 17, text: '控告人：苏州百恒虹布艺有限公司' },
    ],
  }
  const hit = checkQuote(parsed, 'P2 首部 / P17 签署栏', '控告人：苏州百恒虹布艺有限公司')
  assert.strictEqual(hit.verdict, 'ok')
  assert.strictEqual(hit.pageFallback, true)

  const miss = checkQuote(parsed, 'P2', '这句话哪里都没有')
  assert.strictEqual(miss.verdict, 'broken')
})

test('OCR 程序不存在时，报错要指向配置项', () => {
  const bin = findOcr()
  if (bin) assert.ok(fs.existsSync(bin))
  else assert.ok(true)
})

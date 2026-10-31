import test from 'node:test'
import assert from 'node:assert'
import { middleToUnits, tableToRows, looksLikeNarration, compactRanges, contiguousRanges } from '../lib/core/middle.js'

// fixture 结构照抄 MinerU 4.0.12 的真实输出（见 /tmp/m40/r.json 的形状）：
// { schema, is_full_document, pages:[{ page_idx, blocks:[{type, index, bbox, content:[{type, content}]}] }] }
function middle(pages, extra = {}) {
  return { schema: 'docvortex.middle', schema_version: '2.0', is_full_document: false, pages, ...extra }
}
const textBlock = (text, type = 'text') => ({ type, index: 0, bbox: [0, 0, 1, 1], content: [{ type: 'text', content: text }] })

test('page_idx 是源 PDF 的 0-based 页序：page_idx=3 → 第 4 页', () => {
  const r = middleToUnits(middle([
    { page_idx: 3, blocks: [textBlock('甲方：某某公司')] },
    { page_idx: 4, blocks: [textBlock('乙方：某某')] },
  ]))
  assert.deepStrictEqual(r.units.map((u) => u.page), [4, 5])
  assert.strictEqual(r.units[0].text, '甲方：某某公司')
  assert.strictEqual(r.fullDocument, false)
})

test('没有 blocks 键的页是空白页：保留页号占位，不算缺页也不产单元', () => {
  const r = middleToUnits(middle([
    { page_idx: 41, blocks: [] }, // 有的页给空数组
    { page_idx: 42 }, // 有的页连 blocks 都没有——实测 p42/p44 就是这样
    { page_idx: 43, blocks: [textBlock('最后一页正文')] },
  ]))
  assert.deepStrictEqual(r.blankPages, [42, 43])
  assert.strictEqual(r.units.length, 1)
  assert.strictEqual(r.units[0].page, 44)
})

test('英文幻觉块整块丢弃；含中文的行即使是英文段落也保留', () => {
  const r = middleToUnits(middle([
    {
      page_idx: 0,
      blocks: [
        textBlock('The image provided is a QR code. It does not contain any text, mathematical formulas, or tables.'),
        textBlock('This image contains no discernible text.'),
        textBlock('合同编号 WINIT-2018 由 Alpha Corp 与 Beta Ltd 签署'),
      ],
    },
  ]))
  assert.strictEqual(r.droppedNarration, 2)
  assert.strictEqual(r.units.length, 1, '只有带中文的那行留下')
  assert.ok(r.units[0].text.includes('WINIT-2018'))
})

test('表格 <table> 按行转成 "A | B | C"，单元格值可被引文命中', () => {
  const html = '<table><tbody><tr><td>6</td><td>江苏阿路美格销售有限公司</td><td>30%</td></tr><tr><td>7</td><td>安徽瑞达</td><td>1.47%</td></tr></tbody></table>'
  const rows = tableToRows(html)
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(rows[0], '6 | 江苏阿路美格销售有限公司 | 30%')
  const r = middleToUnits(middle([{ page_idx: 0, blocks: [{ type: 'table', index: 1, content: [{ type: 'table_body', content: html }] }] }]))
  assert.strictEqual(r.units.length, 2)
  assert.strictEqual(r.units[1].blockType, 'table')
  assert.ok(r.units.map((u) => u.text).join('\n').includes('30%'), '金额类单元格必须能被 substring 核对到')
})

test('HTML 实体解码与空单元格折叠', () => {
  assert.strictEqual(tableToRows('<tr><td>甲方&amp;乙方</td><td></td><td>100&nbsp;元</td></tr>')[0], '甲方&乙方 | 100 元')
})

test('协议不对时明确报错，而不是吐一堆空单元', () => {
  assert.throws(() => middleToUnits({ schema: 'mineru.md', pages: [] }), /docvortex\.middle/)
  assert.throws(() => middleToUnits(middle([])), /没有任何页/)
})

test('页区间压缩与连续分组', () => {
  assert.strictEqual(compactRanges([1, 2, 3, 7, 8, 10]), '1-3,7-8,10')
  assert.strictEqual(compactRanges([]), '')
  assert.deepStrictEqual(contiguousRanges([1, 2, 3, 7, 9, 10]), [[1, 3], [7, 7], [9, 10]])
})

test('叙述识别不误伤正常英文引用', () => {
  assert.strictEqual(looksLikeNarration('The image provided is a QR code.'), true)
  assert.strictEqual(looksLikeNarration('The Employer shall pay within 7 days'), false, '正常英文条款不能被当幻觉丢')
  assert.strictEqual(looksLikeNarration('The image 是一张二维码'), false, '中英混排按正文处理')
})

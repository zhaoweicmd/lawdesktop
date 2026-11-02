import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeZip } from '../lib/core/zipwrite.js'
import { readPptx } from '../lib/core/pptx.js'
import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { parseMaterial, locate } from '../lib/core/parse.js'

function slideXml(paras) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>' +
    paras
      .map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`)
      .join('') +
    '</p:spTree></p:cSld></p:sld>'
  )
}

function makePptx(file, slides) {
  const entries = [{ name: '[Content_Types].xml', data: '<Types/>' }]
  slides.forEach((paras, i) => {
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: slideXml(paras) })
  })
  fs.writeFileSync(file, writeZip(entries))
}

test('pptx：按幻灯片顺序取文本，页码记在单元上', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-pptx-'))
  const f = path.join(dir, '汇报.pptx')
  makePptx(f, [['第一页标题', '第一页正文'], ['第二页标题']])
  const r = readPptx(fs.readFileSync(f))
  assert.strictEqual(r.slides, 2)
  assert.strictEqual(r.units.length, 3)
  assert.deepStrictEqual(r.units.map((u) => u.page), [1, 1, 2])
  assert.strictEqual(r.units[0].text, '第一页标题')
  assert.strictEqual(r.units[2].text, '第二页标题')
})

test('pptx：slide10 不会排到 slide2 前面（按数字排，不按字典序）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-pptx2-'))
  const f = path.join(dir, '多页.pptx')
  const slides = Array.from({ length: 11 }, (_, i) => [`第${i + 1}页`])
  makePptx(f, slides)
  const r = readPptx(fs.readFileSync(f))
  assert.strictEqual(r.slides, 11)
  assert.strictEqual(r.units[1].text, '第2页', '第2页必须排第2')
  assert.strictEqual(r.units[9].text, '第10页')
})

test('pptx：run 被拆成多个 a:t 时要拼回一整句', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-pptx3-'))
  const f = path.join(dir, '拆分.pptx')
  const xml =
    '<?xml version="1.0"?><p:sld xmlns:p="x" xmlns:a="y"><p:cSld><p:spTree><p:sp><p:txBody>' +
    '<a:p><a:r><a:t>金额为</a:t></a:r><a:r><a:t>1,234</a:t></a:r><a:r><a:t> 万元</a:t></a:r></a:p>' +
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  fs.writeFileSync(f, writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'ppt/slides/slide1.xml', data: xml },
  ]))
  const r = readPptx(fs.readFileSync(f))
  assert.strictEqual(r.units.length, 1)
  assert.strictEqual(r.units[0].text, '金额为1,234 万元')
})

test('pptx 走材料解析：单元可定位，写页码定位', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-pptx4-'))
  const caseDir = path.join(dir, 'case')
  newCase({ dir: caseDir, title: '测试案', parties: '甲；乙' })
  const src = path.join(dir, 'src')
  fs.mkdirSync(src)
  makePptx(path.join(src, '材料.pptx'), [['第一页内容'], ['第二页内容']])
  scanMaterials({ case: caseDir, source: src })
  const r = await parseMaterial({ case: caseDir, id: 'M1' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.units, 2)
  const rec = JSON.parse(fs.readFileSync(r.path, 'utf8'))
  const loc = locate(rec, '第2页')
  assert.strictEqual(loc.ok, true)
  assert.ok(loc.text.includes('第二页内容'))
})

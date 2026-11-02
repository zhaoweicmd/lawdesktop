import test from 'node:test'
import assert from 'node:assert/strict'
import { toTiaoNum, articleNumber } from '../lib/core/law.js'
import { extractJson, tryParseJson } from '../lib/core/clijson.js'

test('toTiaoNum：普通条号 → 数字字符串', () => {
  assert.equal(toTiaoNum('第五百零九条', 509), '509')
  assert.equal(toTiaoNum('第二条'), '2')
})

test('toTiaoNum：附属条文用「之一」时转成法宝的 2.1 写法', () => {
  assert.equal(toTiaoNum('第二条之一', 2), '2.1')
  assert.equal(toTiaoNum('第一千零七十九条之二', 1079), '1079.2')
})

test('toTiaoNum：没有「之一」时不受影响', () => {
  assert.equal(toTiaoNum('第五百七十七条'), '577')
})

test('extractJson：跳过 CLI 的提示行（两个 CLI 都有这个问题）', () => {
  assert.equal(extractJson('调用 fatiao / get_law_item_content …\n\n{"Message":"成功"}'), '{"Message":"成功"}')
  assert.equal(extractJson('正在调用 company/get_company_registration_info...\n\n{"a":1}'), '{"a":1}')
})

test('tryParseJson：解析失败返回 null 而不是抛错', () => {
  assert.deepEqual(tryParseJson('{"a":1}'), { a: 1 })
  assert.equal(tryParseJson('纯文本'), null)
})

test('法宝返回结构：Message/Data.FullText 是正文所在', () => {
  const payload = {
    Message: '成功',
    Data: {
      Title: '中华人民共和国民法典',
      Url: '[北大法宝](https://www.pkulaw.com/chl/x.html?way=mcp#tiao_509)',
      TimelinessDic: ['现行有效'],
      FullText: '第五百零九条　当事人应当按照约定全面履行自己的义务。',
    },
  }
  assert.equal(payload.Message, '成功')
  assert.ok(payload.Data.FullText.includes('全面履行自己的义务'))
  assert.ok(payload.Data.TimelinessDic[0] === '现行有效')
  // URL 是 markdown 链接形式，需要解出纯 URL
  const url = payload.Data.Url.replace(/^\[[^\]]*\]\(([^)]+)\)$/, '$1')
  assert.match(url, /^https:\/\//)
})

test('articleNumber 仍能处理中文数字（回归）', () => {
  assert.equal(articleNumber('第五百零九条'), 509)
  assert.equal(articleNumber('第一千二百六十条'), 1260)
})

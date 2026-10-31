import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publishSkill, listSkills, testSkill, loadSkill } from '../lib/core/skill.js'
import { newCase } from '../lib/core/case.js'
import { draftSkill } from '../lib/tools/skill.js'

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `lawcase-skill-${t}-`))

const GOOD_ITEMS = [
  { name: '付款条件', check: '第四条付款条款：节点是否与验收报告挂钩', failSignal: '付款以对方内部审批为条件' },
  { name: '违约金', check: '违约责任条款：违约金比例与上限金额', failSignal: '违约金无上限' },
]

function makeCase(dir, items = GOOD_ITEMS) {
  const caseDir = path.join(dir, 'case')
  newCase({ dir: caseDir, title: 'Skill 测试案', parties: '甲；乙' })
  draftSkill({ case: caseDir, name: '合同审核', scene: '测试场景', items })
  return caseDir
}

/** 直接造一个已发布的 skill.json，用来测三测能不能抓错 */
function seedSkill(root, name, patch) {
  const dir = path.join(root, 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  const base = {
    name,
    scene: 'x',
    template:
      '【级别】问题：<a>\n依据：<b>\n修改方案：<c>\n落点：<d>\n级别不得自创：重大风险 / 建议修改 / 提示',
    items: [{ name: 'a', check: '第三条金额', failSignal: 'b' }],
    forbidden: [
      { text: '不得使用「进一步明确」' },
      { text: '不得只说有风险不给替换文本' },
      { text: '不得越过条款编号' },
    ],
  }
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ ...base, ...patch }), 'utf8')
  return dir
}

test('Skill：起草→发布→列表→三测全过', () => {
  const root = tmp('ok')
  const caseDir = makeCase(root)
  const p = publishSkill({ root, case: caseDir, name: '合同审核' })
  assert.ok(p.ok)
  assert.ok(fs.existsSync(path.join(root, 'skills', '合同审核', 'skill.json')))
  const ls = listSkills({ root })
  assert.strictEqual(ls.count, 1)
  assert.strictEqual(ls.skills[0].items, 2)
  const t = testSkill({ root, name: '合同审核' })
  assert.strictEqual(t.pass, true, t.summary)
})

test('Skill：清单写成空话，测一必须不过', () => {
  const root = tmp('vague')
  seedSkill(root, '坏清单', {
    items: [{ name: '看合同', check: '注意风险', failSignal: '有风险' }],
  })
  const t = testSkill({ root, name: '坏清单' })
  assert.strictEqual(t.pass, false)
  const t1 = t.tests.find((x) => x.key === 'executable')
  assert.strictEqual(t1.pass, false)
  assert.ok(t1.problems.some((p) => /缺少具体定位/.test(p)), t1.problems.join('|'))
})

test('Skill：禁区不足 3 条，测三必须不过', () => {
  const root = tmp('forb')
  seedSkill(root, '少禁区', { forbidden: [{ text: '不得瞎写' }] })
  const t = testSkill({ root, name: '少禁区' })
  const t3 = t.tests.find((x) => x.key === 'forbidden')
  assert.strictEqual(t3.pass, false)
  assert.ok(t3.problems.some((p) => /少于 3 条/.test(p)))
})

test('Skill：模板缺级别档位，测二必须不过', () => {
  const root = tmp('caliber')
  seedSkill(root, '缺档位', { template: '问题：<a>\n依据：<b>\n修改方案：<c>\n落点：<d>' })
  const t = testSkill({ root, name: '缺档位' })
  const t2 = t.tests.find((x) => x.key === 'caliber')
  assert.strictEqual(t2.pass, false)
  assert.ok(t2.problems.some((p) => /重大风险/.test(p)))
})

test('Skill：没发布就测，报错要点明现有可用项', () => {
  const root = tmp('missing')
  seedSkill(root, '已有一个', {})
  assert.throws(() => loadSkill({ root, name: '不存在' }), /没有已发布的 Skill《不存在》.*现有：已有一个/s)
})

test('Skill：draftSkill 同时落结构化 json（三测与复用它，不靠解析 md）', () => {
  const root = tmp('json')
  const caseDir = makeCase(root)
  const j = JSON.parse(fs.readFileSync(path.join(caseDir, 'skill', '合同审核.json'), 'utf8'))
  assert.strictEqual(j.items.length, 2)
  assert.ok(/不得自创/.test(j.template), '模板应写明级别不得自创')
  assert.strictEqual(j.forbidden.length >= 3, true)
})

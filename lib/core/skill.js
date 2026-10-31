/**
 * skill.js — 经验固化的「跨案件复用 + 三测」。
 *
 * 思路：draftSkill 从一次真实审核里沉淀出四件套（清单/口径/模板/禁区），
 * 存成结构化 skill.json + 人读 SKILL.md；publish 把它提升到全公司可用（<root>/skills/），
 * test 对 Skill 本体做三测，保证它拿得起来就能用，而不是一份写完没人看的文档。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJsonAtomic, nowIso, log } from './store.js'
import { VAGUE } from './clause.js'

const MAX_ITEMS = 12
const MIN_FORBIDDEN = 3

/** 清单里出现这些词，说明「检查什么」是空话，执行时无从下手 */
const CONCRETE_HINTS = [
  '第', '条', '项', '款', '附件', '金额', '期限', '日期', '比例', '主体',
  '签名', '盖章', '账户', '发票', '管辖', '违约金', '保证金', '验收', '交付',
]
const VAGUE_VERBS = ['注意', '关注', '重视', '把握', '留意', '加强']

export function skillRootOf(root) {
  if (!root) throw new Error('尚未解析出案件根目录：请先配置 root 或建案')
  return path.join(root, 'skills')
}

export function safeName(name) {
  return String(name || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-')
}

/** 把案件里沉淀的 Skill 提升为全局可用 */
export function publishSkill({ root, case: caseDir, name }) {
  const dir = path.resolve(caseDir)
  const nm = String(name || '').trim()
  if (!nm) throw new Error('Skill 名称必填')
  const srcJson = path.join(dir, 'skill', `${safeName(nm)}.json`)
  const srcMd = path.join(dir, 'skill', `${safeName(nm)}.md`)
  if (!fs.existsSync(srcJson)) {
    throw new Error(`案件里没有 Skill《${nm}》的结构化数据：请先用 lc_skill_draft 生成`)
  }
  const data = readJson(srcJson, null)
  if (!data) throw new Error(`Skill 数据读不出来：${srcJson}`)
  const target = path.join(skillRootOf(root), safeName(nm))
  fs.mkdirSync(target, { recursive: true })
  writeJsonAtomic(path.join(target, 'skill.json'), { ...data, publishedAt: nowIso() })
  if (fs.existsSync(srcMd)) fs.copyFileSync(srcMd, path.join(target, 'SKILL.md'))
  log(dir, 'skill-publish', { name: nm, target })
  return {
    ok: true,
    dir: target,
    summary: `已发布 Skill《${nm}》到 ${target}｜全公司可用`,
  }
}

/** 列出全局可用 Skill */
export function listSkills({ root }) {
  const base = skillRootOf(root)
  const out = []
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const j = readJson(path.join(base, d.name, 'skill.json'), null)
      if (!j) continue
      out.push({
        name: j.name || d.name,
        scene: j.scene || '',
        items: (j.items || []).length,
        forbidden: (j.forbidden || []).length,
        publishedAt: j.publishedAt,
        from: j.from,
      })
    }
  }
  return {
    ok: true,
    count: out.length,
    skills: out,
    summary: out.length
      ? `可用 Skill ${out.length} 个：` + out.map((s) => `${s.name}（${s.items} 项）`).join('、')
      : '还没有已发布的 Skill：先在某个案件里 lc_skill_draft，再 lc_skill_publish',
  }
}

export function loadSkill({ root, name }) {
  const base = path.join(skillRootOf(root), safeName(name))
  const j = readJson(path.join(base, 'skill.json'), null)
  if (!j) {
    const avail = listSkills({ root }).skills.map((s) => s.name)
    throw new Error(
      `没有已发布的 Skill《${name}》` +
        (avail.length ? `。现有：${avail.join('、')}` : '。先用 lc_skill_publish 发布一个')
    )
  }
  return j
}

/** 测一：清单能不能照着执行 */
function testExecutable(sk) {
  const items = sk.items || []
  const problems = []
  if (!items.length) problems.push('检查清单为空')
  if (items.length > MAX_ITEMS) problems.push(`清单 ${items.length} 项，超过 ${MAX_ITEMS} 项上限（执行时会跳项）`)
  items.forEach((it, i) => {
    const check = String(it.check || '')
    const fail = String(it.failSignal || '')
    if (!check) problems.push(`第 ${i + 1} 项缺「检查什么」`)
    if (!fail) problems.push(`第 ${i + 1} 项缺「什么算不过」`)
    if (!CONCRETE_HINTS.some((h) => check.includes(h))) {
      problems.push(`第 ${i + 1} 项「${it.name}」缺少具体定位（条/项/金额/期限/主体…），执行时无从下手`)
    }
    const v = VAGUE_VERBS.filter((w) => check.includes(w))
    if (v.length) problems.push(`第 ${i + 1} 项用了「${v.join('、')}」这类空动词，换成可观察的动作`)
  })
  return { key: 'executable', name: '测一 · 可执行性', pass: problems.length === 0, problems }
}

/** 测二：级别口径是否唯一且三档齐全 */
function testCaliber(sk) {
  const tpl = String(sk.template || '')
  const problems = []
  for (const lv of ['重大风险', '建议修改', '提示']) {
    if (!tpl.includes(lv)) problems.push(`模板里缺「${lv}」这一档的定义`)
  }
  if (!/不得自创|三档/.test(tpl)) problems.push('模板没有写「级别不得自创」，执行时容易出现第四档')
  const four = ['【级别】', '问题：', '依据：', '修改方案：', '落点：']
  for (const f of four) if (!tpl.includes(f)) problems.push(`输出模板缺「${f}」字段`)
  return { key: 'caliber', name: '测二 · 口径唯一', pass: problems.length === 0, problems }
}

/** 测三：禁区是否可自动识别 */
function testForbidden(sk) {
  const list = sk.forbidden || []
  const problems = []
  if (list.length < MIN_FORBIDDEN) problems.push(`禁区只有 ${list.length} 条，少于 ${MIN_FORBIDDEN} 条`)
  const machineCheckable = list.filter(
    (f) => VAGUE.some((v) => String(f.text).includes(v)) || /不得|禁止|不能|严禁/.test(String(f.text))
  )
  if (!machineCheckable.length) {
    problems.push('没有一条禁区能被机器识别（要含「不得/禁止」或 VAGUE 词），等于只能靠人盯')
  }
  return { key: 'forbidden', name: '测三 · 禁区可判定', pass: problems.length === 0, problems }
}

/** 对已发布的 Skill 跑三测 */
export function testSkill({ root, name, case: caseDir }) {
  const sk = loadSkill({ root, name })
  const tests = [testExecutable(sk), testCaliber(sk), testForbidden(sk)]
  const pass = tests.every((t) => t.pass)
  if (caseDir) {
    try {
      log(path.resolve(caseDir), 'skill-test', { name, pass })
    } catch {}
  }
  return {
    ok: true,
    name: sk.name || name,
    pass,
    tests,
    summary:
      `${pass ? '通过' : '未通过'}｜` +
      tests.map((t) => `${t.name}${t.pass ? '✓' : `✗(${t.problems.length})`}`).join('｜'),
  }
}

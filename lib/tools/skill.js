import fs from 'node:fs'
import path from 'node:path'
import { casePaths, readJson, readJsonl, nowIso, log, writeJsonAtomic } from '../core/store.js'
import { VAGUE } from '../core/clause.js'

const MAX_ITEMS = 12
const MIN_FORBIDDEN = 3

const TEMPLATE = `## 三、输出模板

每条意见固定四段，缺一段即为不合格：

\`\`\`
【级别】问题：<哪句话 / 哪个约定，导致什么后果>
依据：<法条 / 对价失衡 / 行业惯例，说不出来就写"经验判断">
修改方案：
<可直接替换的条文，不是方向性建议>
落点：<第X条第Y项>
\`\`\`

级别口径（三档，不得自创）：
- **重大风险**：不改就不能签——责任无上限、权利全丧失、回款条件不可成就、单方可变更合同
- **建议修改**：不改能签但会吃亏——义务不对等、时限缺失、后果不明
- **提示**：不影响权利义务，但影响认定或税务——名称不一致、模板残留、条号引用错误
`

const FORBIDDEN_BASE = [
  '不得使用「进一步明确」「予以完善」「酌情」「视情况」等空泛表述——这类话客户拿不到任何可执行的东西，等于没提。',
  '不得只说"有风险"不给替换文本——风险提示必须落到一句能直接贴回合同的条文。',
  '不得越过条款编号泛泛而谈——每条意见必须指向具体的「第X条」及其项号。',
]

export function draftSkill({ case: caseDirRaw, name, scene, items, forbidden, basisFrom }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}`)
  const nm = String(name || '').trim()
  if (!nm) throw new Error('Skill 名称必填（如「合同审核」）')
  if (!Array.isArray(items) || !items.length) throw new Error('检查清单不能为空：至少给 1 项检查点')
  if (items.length > MAX_ITEMS) {
    throw new Error(`检查清单最多 ${MAX_ITEMS} 项（现在 ${items.length} 项）：清单太长执行时会跳项，宁可少而硬`)
  }
  const norm = items.map((it, i) => {
    const n = String(it.name || '').trim()
    const check = String(it.check || '').trim()
    const fail = String(it.failSignal || '').trim()
    if (!n) throw new Error(`第 ${i + 1} 项缺 name`)
    if (!check) throw new Error(`第 ${i + 1} 项「${n}」缺 check：要写清看哪个位置、看什么`)
    if (!fail) throw new Error(`第 ${i + 1} 项「${n}」缺 failSignal：没写「什么算不过」，这一项就无法判定`)
    const vague = VAGUE.filter((v) => check.includes(v) || fail.includes(v))
    if (vague.length) throw new Error(`第 ${i + 1} 项「${n}」含空泛表述（${vague.join('、')}）：换成可观察的事实`)
    return { name: n, check, failSignal: fail }
  })
  const forb = [...FORBIDDEN_BASE.map((t) => ({ text: t, why: '通用禁区' }))]
  for (const f of Array.isArray(forbidden) ? forbidden : []) {
    const t = String(f.text || f || '').trim()
    if (!t) continue
    forb.push({ text: t, why: String(f.why || '场景禁区').trim() })
  }
  if (forb.length < MIN_FORBIDDEN) throw new Error(`禁区至少 ${MIN_FORBIDDEN} 条`)

  // 从本案件已有的审核意见里提炼「口径」：真实用过的级别与措辞比编的更可信
  const notes = readJsonl(cp.notes).filter((r) => !r.__broken && !r.__deleted)
  const byLevel = {}
  for (const n of notes) byLevel[n.level] = (byLevel[n.level] || 0) + 1
  const levelStat = Object.keys(byLevel).length
    ? Object.entries(byLevel).map(([k, v]) => `${k} ${v} 条`).join('、')
    : '（本案暂无历史意见）'

  const skillDir = path.join(dir, 'skill')
  fs.mkdirSync(skillDir, { recursive: true })
  const safe = nm.replace(/[\\/:*?"<>|\s]+/g, '-')
  const outFile = path.join(skillDir, `${safe}.md`)

  const lines = [
    `# Skill：${nm}`,
    '',
    `- 场景：${scene || '合同审核'}`,
    `- 来源案件：${c.title}（${c.caseId}）`,
    `- 生成时间：${nowIso()}`,
    `- 口径沉淀：${levelStat}${basisFrom ? `｜依据 ${basisFrom}` : ''}`,
    '',
    '## 一、检查清单',
    '',
    '按顺序过，每项要么给出结论，要么明确写"本项不适用"。',
    '',
    '| # | 检查项 | 检查什么 | 什么样的结果算不过 |',
    '|---|---|---|---|',
    ...norm.map((it, i) => `| ${i + 1} | ${it.name} | ${it.check} | ${it.failSignal} |`),
    '',
    TEMPLATE,
    '## 四、禁区',
    '',
    ...forb.map((f, i) => `${i + 1}. ${f.text}${f.why && f.why !== '通用禁区' ? `（${f.why}）` : ''}`),
    '',
    '---',
    '',
    '> 本 Skill 由 LawCase 从真实案件沉淀生成。修改列表请重新生成，不要手改——手改会让清单与沉淀口径脱节。',
    '',
  ]
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8')
  // 结构化副本：跨案件复用与三测都读它，不靠解析 markdown
  const dataFile = path.join(skillDir, `${safe}.json`)
  writeJsonAtomic(dataFile, {
    name: nm,
    scene: String(scene || '合同审核').trim(),
    template: TEMPLATE,
    items: norm,
    forbidden: forb,
    from: { caseId: c.caseId, title: c.title },
    createdAt: nowIso(),
  })
  log(dir, 'skill-draft', { name: nm, items: norm.length, forbidden: forb.length })
  return {
    ok: true, file: outFile, dataFile, items: norm.length, forbidden: forb.length,
    summary: `已生成 Skill《${nm}》${outFile}｜检查项 ${norm.length} 项、禁区 ${forb.length} 条`,
  }
}

import { publishSkill, listSkills, testSkill } from '../core/skill.js'

export const skillTools = [
  {
    name: 'lc_skill_publish',
    description:
      '把某个案件里沉淀的 Skill 提升为全公司可用（写到 <案件根>/skills/）。' +
      '固化经验的意义在于下次同类案子直接拿来用，只留在单个案件里等于没固化。',
    parameters: {
      case: { type: 'string', required: true, description: '来源案件工作目录' },
      name: { type: 'string', required: true, description: 'Skill 名称（须已 lc_skill_draft 生成）' },
    },
    execute: async (args) => publishSkill(args),
  },
  {
    name: 'lc_skill_list',
    description: '列出全公司可用的 Skill（名称、场景、检查项数、禁区数、来源案件）。纯读。',
    parameters: {
      case: { type: 'string', required: true, description: '任一案件目录（用来定位案件根）' },
    },
    execute: async (args) => {
      const { resolveRoot } = await import('../core/paths.js')
      const root = resolveRoot({ root: 'auto' }, path.resolve(args.case, '..', '..'))
      return listSkills({ root: root || path.dirname(path.resolve(args.case)) })
    },
  },
  {
    name: 'lc_skill_test',
    description:
      '对已发布的 Skill 跑三测：①可执行性（清单是否指向具体位置）②口径唯一（级别三档是否齐全互斥）' +
      '③禁区可判定（能否被机器识别）。三项全过才算这个 Skill 拿得起来就能用。',
    parameters: {
      case: { type: 'string', required: true, description: '案件目录（用于定位 Skill 根与记日志）' },
      name: { type: 'string', required: true, description: 'Skill 名称' },
    },
    execute: async (args) => {
      const { resolveRoot } = await import('../core/paths.js')
      const root = resolveRoot({ root: 'auto' }, path.resolve(args.case, '..', '..'))
      return testSkill({ root: root || path.dirname(path.resolve(args.case)), name: args.name, case: args.case })
    },
  },
]

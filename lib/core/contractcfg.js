// 合同审核口径：立场、合同类型、补充要求。
//
// 为什么要有它：同一条合同条款，站在甲方和站在乙方看出来的风险完全不同。
// 以前这些只存在于对话里，复核的人打开案件看不出"这份意见是替谁审的"。
// 现在落到 case.json 的 review 字段，报告首页、面板、交付包都会带上。
//
// 本文件纯数据 + 纯函数，不调 LLM。

import path from 'node:path'

import { casePaths, readJson, writeJsonAtomic, nowIso, log } from './store.js'

/** 审查立场 */
export const STANCES = [
  { value: 'neutral', label: '中立审查', hint: '两边风险都提示，不偏向任何一方' },
  { value: 'partyA', label: '站在甲方立场', hint: '以甲方（委托方/买方/发包方）利益为主线提出修改' },
  { value: 'partyB', label: '站在乙方立场', hint: '以乙方（受托方/卖方/承包方）利益为主线提出修改' },
]

const STANCE_VALUES = STANCES.map((s) => s.value)

export function stanceLabel(v) {
  const hit = STANCES.find((s) => s.value === String(v || ''))
  return hit ? hit.label : '中立审查'
}

/** 共同口径：任何合同都该过一遍的五件事 */
const SHARED_RULES = [
  { id: 'parties', title: '主体与签署', guidance: '核对双方名称、签署主体和授权信息；缺失时明确指出，不自行补全。' },
  { id: 'payment', title: '价款与付款', guidance: '检查金额、币种、税费、付款条件和时间是否清晰、一致。' },
  { id: 'term', title: '履行期限', guidance: '检查生效条件、履行起止时间及终止安排。' },
  { id: 'liability', title: '违约与责任', guidance: '检查责任是否清楚、是否存在明显失衡或无限责任，结合立场提出建议。' },
  { id: 'dispute', title: '争议处理', guidance: '检查争议处理方式和约定机构是否明确；不编造法条或机构。' },
]

/** 合同类型模板：不同类型合同的"必查项"不同 */
export const CONTRACT_TEMPLATES = [
  {
    id: 'general',
    title: '通用合同',
    description: '主体、价款、期限与责任的基础核对',
    rules: [...SHARED_RULES, { id: 'consistency', title: '遗漏与前后矛盾', guidance: '检查未填写内容、引用不存在的附件、前后冲突和关键约定缺失。' }],
  },
  {
    id: 'purchase',
    title: '采购合同',
    description: '重点看交付、验收与质量保证',
    rules: [
      ...SHARED_RULES,
      { id: 'delivery', title: '标的与交付', guidance: '检查规格、数量、交付地点和交付时间是否明确。' },
      { id: 'acceptance', title: '验收与质保', guidance: '检查验收标准、期限、异议流程和质量保证安排。' },
    ],
  },
  {
    id: 'service',
    title: '服务合同',
    description: '重点看服务边界、成果与知识产权',
    rules: [
      ...SHARED_RULES,
      { id: 'scope', title: '服务范围与成果', guidance: '检查服务边界、交付成果、验收标准和需求变更处理。' },
      { id: 'ip', title: '成果与保密', guidance: '检查成果权属、第三方素材、保密义务与资料返还安排。' },
    ],
  },
  {
    id: 'lease',
    title: '租赁合同',
    description: '重点看租金、押金与交还条件',
    rules: [
      ...SHARED_RULES,
      { id: 'asset', title: '租赁物与用途', guidance: '检查租赁物范围、现状、用途限制和交付条件。' },
      { id: 'deposit', title: '押金与退出', guidance: '检查押金扣除及退还条件、维修分担、提前退出和交还条件。' },
    ],
  },
]

const TEMPLATE_IDS = CONTRACT_TEMPLATES.map((t) => t.id)

export const DEFAULT_REVIEW_CONFIG = { stance: 'neutral', templateId: 'general', instructions: '' }

/** 读出来一定是完整形状：老案件没有 review 字段时给默认值，不让下游各自兜底 */
export function normalizeReviewConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const stance = STANCE_VALUES.includes(String(r.stance)) ? String(r.stance) : DEFAULT_REVIEW_CONFIG.stance
  const templateId = TEMPLATE_IDS.includes(String(r.templateId)) ? String(r.templateId) : DEFAULT_REVIEW_CONFIG.templateId
  return {
    stance,
    templateId,
    instructions: String(r.instructions || '').trim().slice(0, 2000),
    updatedAt: r.updatedAt || null,
  }
}

export function templateOf(templateId) {
  return CONTRACT_TEMPLATES.find((t) => t.id === String(templateId || '')) || CONTRACT_TEMPLATES[0]
}

/** 按模板给出一份"该查什么"的清单（给 agent 与报告用，不给 LLM 直接当 prompt） */
export function reviewRules({ templateId } = {}) {
  const t = templateOf(templateId)
  return t.rules.map((x) => ({ ...x }))
}

/** 一段可读的口径摘要：报告首页、面板头部都用它，避免两处各写一份 */
export function reviewBrief(config) {
  const c = normalizeReviewConfig(config)
  const t = templateOf(c.templateId)
  const parts = [`立场：${stanceLabel(c.stance)}`, `类型：${t.title}`]
  if (c.instructions) parts.push(`补充要求：${c.instructions}`)
  return parts.join('｜')
}

/** 读案件里的审核配置（纯读，缺省给默认） */
export function readReviewConfig(caseDirRaw) {
  const dir = path.resolve(String(caseDirRaw || ''))
  const c = readJson(casePaths(dir).caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}`)
  return normalizeReviewConfig(c.review)
}

/**
 * 写审核配置。只改 case.json 里的 review 字段，不碰条款与意见。
 * 传 undefined 的字段保持原值——这样界面可以只改立场而不清空补充要求。
 */
export function setReviewConfig({ case: caseDirRaw, stance, templateId, instructions } = {}) {
  const dir = path.resolve(String(caseDirRaw || ''))
  if (!caseDirRaw) throw new Error('case 不能为空：请给出案件工作目录绝对路径')
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  if (!c) throw new Error(`不是 LawCase 案件：${dir}`)
  if (c.caseType !== 'contract') {
    throw new Error(`本案案型是「${c.caseType === 'litigation' ? '诉讼/争议' : c.caseType}」，审核口径只对合同审核案有意义`)
  }

  const prev = normalizeReviewConfig(c.review)
  const next = normalizeReviewConfig({
    stance: stance === undefined ? prev.stance : stance,
    templateId: templateId === undefined ? prev.templateId : templateId,
    instructions: instructions === undefined ? prev.instructions : instructions,
    updatedAt: nowIso(),
  })
  // 立场的取值必须真的是那三个之一，否则上面会静默回退到默认——那是"改了没生效"的经典坑
  if (stance !== undefined && !STANCE_VALUES.includes(String(stance))) {
    throw new Error(`立场只能是：${STANCE_VALUES.join(' / ')}（收到「${stance}」）`)
  }
  if (templateId !== undefined && !TEMPLATE_IDS.includes(String(templateId))) {
    throw new Error(`合同类型只能是：${TEMPLATE_IDS.join(' / ')}（收到「${templateId}」）`)
  }

  c.review = next
  c.updatedAt = nowIso()
  writeJsonAtomic(cp.caseJson, c)
  log(dir, 'review-config', { stance: next.stance, templateId: next.templateId })

  return {
    ok: true,
    review: next,
    brief: reviewBrief(next),
    rules: reviewRules({ templateId: next.templateId }).map((r) => ({ id: r.id, title: r.title })),
    summary: `审核口径已更新：${reviewBrief(next)}`,
  }
}

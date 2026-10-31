// 合同审核的三个新工具：预检、审核口径、修订预览。
//
// 都挂在 core 的纯函数上，薄壳，不做判断：
//   lc_precheck           —— 机器能判的硬伤（占位符/编号/附件/覆盖/签署）
//   lc_contract_config    —— 立场 / 合同类型 / 补充要求（写 case.json.review）
//   lc_contract_preview   —— 条款原文 vs 建议条文的字符级对照（不落盘）

import { precheckCase } from '../core/precheck.js'
import { setReviewConfig, readReviewConfig, reviewBrief, reviewRules, STANCES, CONTRACT_TEMPLATES } from '../core/contractcfg.js'
import { previewRevision } from '../core/preview.js'

const STANCE_IDS = STANCES.map((s) => s.value)
const TEMPLATE_IDS = CONTRACT_TEMPLATES.map((t) => t.id)

export const precheckTools = [
  {
    name: 'lc_precheck',
    description:
      '合同预检（确定性，不调 LLM）：扫占位符未填（____/〔〕/待填写/XX/空括号）、条款编号重复与跳号、' +
      '引用附件却无附件条款、关键条款关键词全无、无签署安排。每条结论都指到具体条款与原文，' +
      '并明确声明「关键词缺失不等于条款不充分」。需要先 lc_clause_index。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      file: { type: 'string', description: '只查这份合同（缺省=全部已索引合同）' },
    },
    execute: async (args) => precheckCase(args),
  },
  {
    name: 'lc_contract_config',
    description:
      '读/写合同审核口径：审查立场（中立 / 甲方 / 乙方）、合同类型（通用/采购/服务/租赁）、本次补充要求。' +
      '只传 case 时是只读；带 stance/templateId/instructions 时写入 case.json.review，' +
      '并在意见表首页与面板上显示。立场决定「替谁审」，同一份合同换立场结论会变。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      stance: { type: 'string', description: `审查立场：${STANCE_IDS.join(' / ')}（不传=不改）` },
      templateId: { type: 'string', description: `合同类型：${TEMPLATE_IDS.join(' / ')}（不传=不改）` },
      instructions: { type: 'string', description: '本次补充审核要求（如「重点看付款与验收」（不传=不改）' },
    },
    execute: async (args) => {
      const writing = args.stance !== undefined || args.templateId !== undefined || args.instructions !== undefined
      if (!writing) {
        const review = readReviewConfig(args.case)
        return {
          ok: true,
          review,
          brief: reviewBrief(review),
          rules: reviewRules({ templateId: review.templateId }),
          summary: `当前审核口径：${reviewBrief(review)}`,
        }
      }
      return setReviewConfig(args)
    },
  },
  {
    name: 'lc_contract_preview',
    description:
      '修订对照预览（只读，不落盘）：把每条意见的「条款原文 vs 建议条文」算成字符级差异，' +
      '并给出整份合同按条款合并后的预览文本。用于在生成 docx 前先看改了什么；' +
      '最终修订以 lc_contract_revise 生成的 Word 修订痕迹为准。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      file: { type: 'string', description: '合同文件名（多份合同指定；缺省=最后索引的那份）' },
      noteIds: { type: 'array', description: '只看这几条意见（如 ["N1","N3"]；缺省=全部）' },
    },
    execute: async (args) => previewRevision(args),
  },
]

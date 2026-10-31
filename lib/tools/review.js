import { openReview, addAttack, addReply, addVerdict, listReview } from '../core/review.js'
import { autoReview } from '../core/review_auto.js'

/** 对抗复盘三回合（M7）：只攻击 → 回应 → 裁定 */
export const reviewTools = [
  {
    name: 'lc_review_auto',
    description:
      '一键机器攻击：用台账数据穷举结构性缺陷（事实未复核、法条未回源/抄错/失效、工序未完成、验收未过等），' +
      '生成第一回合的可攻击点。**不自动回应、不自动裁定**——自己判自己，对抗就失效了。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      subject: { type: 'string', description: '复盘对象，如「K1 付款条件成就」' },
    },
    execute: async (args) => autoReview(args),
  },
  {
    name: 'lc_review_open',
    description: '开一轮对抗复盘，指定复盘对象（某条结论/某份文书）。之后三个回合：只攻击 → 回应 → 裁定。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      subject: { type: 'string', required: true, description: '复盘对象，如「K1 付款条件成就」' },
    },
    execute: async (args) => openReview(args),
  },
  {
    name: 'lc_review_attack',
    description:
      '第一回合：登记一个攻击点（只攻击，不给建议）。含「建议补充/应当修改/可以考虑」这类措辞会被拒收。' +
      '已经进入裁定阶段就不能再追加攻击。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      round: { type: 'string', required: true, description: '轮次，如 R1' },
      target: { type: 'string', description: '攻击针对的具体位置/结论编号' },
      text: { type: 'string', required: true, description: '攻击理由：哪一处站不住、凭什么' },
    },
    execute: async (args) => addAttack(args),
  },
  {
    name: 'lc_review_reply',
    description: '第二回合：被攻击方回应。每条攻击只能回应一次，回应是留痕，不能覆盖。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      round: { type: 'string', required: true, description: '轮次，如 R1' },
      aid: { type: 'string', required: true, description: '攻击点编号，如 A1' },
      text: { type: 'string', required: true, description: '回应：承认站不住，或说清凭什么仍成立' },
    },
    execute: async (args) => addReply(args),
  },
  {
    name: 'lc_review_verdict',
    description:
      '第三回合：裁定。必须先回应才能裁定；级别只能是 致命 / 重大 / 一般；判为致命或重大必须写理由。裁定后不能改判。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      round: { type: 'string', required: true, description: '轮次，如 R1' },
      aid: { type: 'string', required: true, description: '攻击点编号，如 A1' },
      severity: { type: 'string', required: true, description: '致命 / 重大 / 一般' },
      note: { type: 'string', description: '裁定理由（致命/重大必填）' },
    },
    execute: async (args) => addVerdict(args),
  },
  {
    name: 'lc_review_list',
    description: '看复盘进度：每轮 攻击/回应/裁定 各多少条，以及未闭环的致命项。纯读。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      round: { type: 'string', description: '只看某一轮，如 R1' },
    },
    execute: async (args) => listReview(args),
  },
]

import { verifyCase } from '../core/verify.js'

/** 验收类工具（M2） */
export const verifyTools = [
  {
    name: 'lc_case_verify',
    description:
      '五道验收：事实可追溯 / 法条可回源 / 逻辑自洽 / 格式合规 / 保密可脱敏。' +
      '只读检查，返回每道通过情况与「必须修」清单；**不会**把案件状态改成 approved——那只能人工确认。',
    parameters: {
      case: {
        type: 'string',
        required: true,
        description: '案件工作目录绝对路径',
      },
      checks: {
        type: 'array',
        description: '只跑指定的几道（facts/law/logic/format/confidential）；不传=全跑',
        items: { type: 'string' },
      },
    },
    execute: async ({ case: c, checks }) => verifyCase({ case: c, checks }),
  },
]

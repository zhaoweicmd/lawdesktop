import { newCase, openCase } from '../core/case.js'

/** 案件与账本类工具（M1） */
export const caseTools = [
  {
    name: 'lc_case_new',
    description:
      '新建一个 LawCase 案件工作目录：生成 .lawcase/ 骨架（case.json、进度台账、结论台账、事实台账、日志）。' +
      '目录已有案件时拒绝覆盖。材料目录作为只读来源登记，不会被写入。',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: '案件工作目录绝对路径（产出写在这里）。目录不存在会自动创建。',
      },
      title: {
        type: 'string',
        required: true,
        description: '案件名称，如「某某公司诉某某公司买卖合同纠纷」。≤80 字。',
      },
      cause: { type: 'string', description: '案由，如「买卖合同纠纷」' },
      caseType: {
        type: 'string',
        enum: ['litigation', 'contract'],
        description: '案型：litigation（诉讼/争议，默认）或 contract（合同审核）。决定验收判据——诉讼看事实能否追到出处，合同审核看条款是否逐条审过、意见能否直接改。',
      },
      parties: { type: 'string', description: '当事人，如「原告：甲公司；被告：乙公司」' },
      materialsDirs: {
        type: 'array',
        description: '材料目录（可为只读归档路径），可多个。仅登记，不写入。',
        items: { type: 'string' },
      },
    },
    execute: async (args) => newCase(args),
  },
  {
    name: 'lc_case_open',
    description:
      '打开已有案件并把状态摊开（开工复述）：工序进度、事实核验情况、材料登记、待确认项、上次操作、下一步建议。' +
      '纯读，不改任何状态。新会话接手案件时先调它，不要靠猜。',
    parameters: {
      case: {
        type: 'string',
        required: true,
        description: '案件工作目录绝对路径（lc_case_new 返回的 dir）',
      },
    },
    execute: async ({ case: c }) => openCase({ case: c }),
  },
  {
    name: 'lc_case_status',
    description:
      '案件全景的紧凑视图：状态、工序进度、事实核验、材料登记、待确认项、下一步。' +
      '与 lc_case_open 的区别：open 给完整复述与人话建议，status 给结构化摘要，适合频繁轮询或写进汇报。纯读。',
    parameters: {
      case: {
        type: 'string',
        required: true,
        description: '案件工作目录绝对路径',
      },
    },
    execute: async ({ case: c }) => {
      const o = openCase({ case: c })
      const proc = o.proc || {}
      return {
        ok: true,
        caseId: o.caseId,
        title: o.title,
        cause: o.cause,
        parties: o.parties,
        dir: o.dir,
        status: o.status,
        updatedAt: o.updatedAt,
        proc,
        facts: o.facts,
        materials: { count: (o.materials && o.materials.count) || 0 },
        pendingConfirm: o.pendingConfirm || [],
        summary: `${o.caseId}｜${o.status}｜工序 ${proc.done || 0}/${proc.total || 0}｜事实 ${(o.facts && o.facts.total) || 0} 条（未核 ${(o.facts && o.facts.unverified) || 0}）`,
      }
    },
  },
]

import { nextStep } from '../core/next.js'
import { caseBrief } from '../core/brief.js'

export const nextTools = [
  {
    name: 'lc_case_next',
    description:
      '状态驱动的「下一步该做什么」：读整个案件状态，找出当前卡点，给出可直接调用的工具名与参数。' +
      '不知道从哪开始时先跑它。纯读，不改案件。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
    },
    execute: async (args) => nextStep(args),
  },
  {
    // 和 lc_case_next 分工：next 回答「下一步调哪个工具」（给模型），
    // brief 回答「现在到哪了、卡在哪、谁刚动过」（给人看，也适合开场注入）。
    // 不合并成一个是刻意的：一个要全，一个必须短到能放在一行。
    name: 'lc_case_brief',
    description:
      '一句话案情简报：上次动作（何时/做了什么）+ 当前卡点 + 核对三段色（绿=核过没变 / 黄=核后又被改 / 灰=从没核过）。' +
      '新会话接手、或想快速判断「这案子现在能不能交」时用它；要调工具链就用 lc_case_next。纯读。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      withNext: {
        type: 'boolean',
        description: '是否顺带跑一次 lc_case_next 对齐「卡点」口径（默认 false，更快）',
      },
    },
    execute: async (args, exec) => {
      const pkgRoot = (exec && exec.__lawcasePkgRoot) || ''
      let next = null
      if (args.withNext) {
        try {
          next = nextStep({ case: args.case })
        } catch (e) {
          next = null
        }
      }
      return caseBrief({ case: args.case, pkgRoot, next })
    },
  },
]

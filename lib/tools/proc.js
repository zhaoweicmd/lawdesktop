import { planProcesses, updateProcess, listProcesses } from '../core/proc.js'

/** 工序表类工具（M3） */
export const procTools = [
  {
    name: 'lc_proc_plan',
    description:
      '提交工序拆解：把案件要做的事拆成有依赖、有验收标准的工序（自动编号 P1、P2…）。' +
      '每条工序**必须**给验收标准，缺了直接拒收；依赖必须成 DAG，成环拒收；已有工序需 replace=true。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      processes: {
        type: 'array',
        required: true,
        description: '工序数组，按执行顺序排。dependsOn 填工序名（不是 id）',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: '工序名，如「梳理合同条款」' },
            acceptance: { type: 'string', required: true, description: '验收标准：怎么算这道工序做完了' },
            inputs: { type: 'string', description: '输入：需要什么材料/前序产出' },
            outputs: { type: 'string', description: '输出：产出什么文件' },
            dependsOn: { type: 'array', description: '依赖的工序名数组', items: { type: 'string' } },
          },
        },
      },
      replace: { type: 'boolean', description: '覆盖已有工序表（会丢弃现有进度）' },
      force: { type: 'boolean', description: '已有工序验收完成时仍强制覆盖' },
    },
    execute: async (args) => planProcesses(args),
  },
  {
    name: 'lc_proc_update',
    description:
      '推进单道工序的状态（todo/doing/done/blocked）。依赖未完成时不允许标 done；已验收的工序不能退回。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      id: { type: 'string', required: true, description: '工序 id，如 P1' },
      status: { type: 'string', required: true, description: 'todo / doing / done / blocked' },
      note: { type: 'string', description: '备注，blocked 时应写阻塞原因' },
      acceptResult: { type: 'boolean', description: '是否已人工验收该工序产出' },
    },
    execute: async (args) => updateProcess(args),
  },
  {
    name: 'lc_proc_list',
    description: '读工序表：总进度、进行中、阻塞、以及「现在可以开工」的工序（依赖已满足）。纯读。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
    },
    execute: async (args) => listProcesses(args),
  },
]

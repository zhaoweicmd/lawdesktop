import { runPipeline } from '../core/pipeline.js'

export const pipelineTools = [
  {
    name: 'lc_case_pipeline',
    description:
      '一键流水线：建案 → 扫材料 → 批量解析（docx/xlsx/pptx/pdf，扫描件自动 OCR）→ 报出还剩什么要人决定。' +
      '**不抽事实、不出结论、不定版本**——那三件事要读懂内容或做判断，不归流水线。' +
      '用于「一堆材料先跑起来」的开局。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      source: { type: 'string', description: '材料源目录（只读，不会写入）；不传则用案件里记录的' },
      title: { type: 'string', description: '新建案件时的案件名称（案件已存在可不传）' },
      parties: { type: 'string', description: '当事人，如「原告：甲；被告：乙」' },
      cause: { type: 'string', description: '案由' },
      kind: { type: 'string', description: '只解析这个扩展名（pdf/docx/pptx/xlsx），不传=全部可解析的' },
      limit: { type: 'number', description: '本次最多解析几份，默认 200' },
      hashMaxMB: { type: 'number', description: '做内容哈希的阈值(MB)，默认 0=不哈希（云盘上很慢）' },
    },
    execute: async (args) => runPipeline(args),
  },
]

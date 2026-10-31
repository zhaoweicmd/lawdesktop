import { scanMaterials, listMaterials, decideMaterial } from '../core/material.js'
import { parseMaterial, readParse, listParsed, parseAll } from '../core/parse.js'

export const materialTools = [
  {
    name: 'lc_material_scan',
    description:
      '扫描材料源目录并登记（**只读源目录，不复制文件**）。自动识别「更新/终稿/副本」版本组与内容重复，' +
      '生成 .lawcase/materials.json 和给人看的分则「材料登记.md」，并列出待确认的旧版。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      source: { type: 'string', description: '材料源目录（绝对路径）；不传则用案件里记录的 materialsDirs[0]' },
      recursive: { type: 'boolean', description: '是否递归子目录，默认 true' },
      hashMaxMB: { type: 'number', description: '做内容哈希的阈值(MB)，默认 0=不哈希（云盘上哈希很慢）' },
    },
    execute: async (args) => scanMaterials(args),
  },
  {
    name: 'lc_material_list',
    description: '读已登记的材料清单（不重新扫描）。staleOnly=true 只看非最新版本。纯读。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      staleOnly: { type: 'boolean', description: '只看被判为旧版的文件' },
    },
    execute: async (args) => listMaterials(args),
  },
  {
    name: 'lc_material_decide',
    description:
      '定版：一组版本文件里指定哪份为准，决定写进材料台账与案件已确认项（不是口头结论）。' +
      '定完会在「材料登记.md」把对应待办勾掉，并更新剩余未定组数。重扫材料不会冲掉已定的结果。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      group: { type: 'string', required: true, description: '版本组里任一材料编号，如 M3' },
      accept: { type: 'string', required: true, description: '定为准确版本的材料编号，如 M2' },
      note: { type: 'string', description: '定版理由，如「更新版含庭后补充意见」' },
    },
    execute: async (args) => decideMaterial(args),
  },
  {
    name: 'lc_material_parse',
    description:
      '把一份材料解析成可定位的文本单元（docx→段落、xlsx→行、pptx→页、pdf→带页码的行）。结果缓存到 .lawcase/cache/parse/。' +
      'PDF 逐页判断：有文本层的页用 pdftotext（零成本），扫描页用 MinerU basic（约 2 秒/页，带版面与表格）；' +
      'MinerU 不可用才退本地 OCR（约 0.7 秒/页，只有散字且会读错日期，降级会写进 coverage.degraded）。内容未变则不重复解析。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      id: { type: 'string', description: '材料编号，如 M5（与 source 二选一）' },
      source: { type: 'string', description: '直接给文件绝对路径（材料清单里没有时用）' },
      force: { type: 'boolean', description: '内容未变也强制重新解析' },
      pdfEngine: { type: 'string', description: "PDF 引擎：auto（默认，逐页判断：有文本层的页走 pdftotext，扫描页走 MinerU）/ mineru（扫描页只用 MinerU，失败就报错不降级）/ ocr（扫描页只用本地 OCR）" },
      tier: { type: 'string', description: "MinerU 档位：basic（默认，扫描件用这个）/ standard（更准但慢数倍，且会在空白页产英文幻觉）/ flash / advanced" },
    },
    execute: async (args) => parseMaterial(args),
  },
  {
    name: 'lc_material_parsed',
    description: '列出已解析的材料及其单元数（段落数/行数）。纯读。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
    },
    execute: async (args) => listParsed(args),
  },
  {
    name: 'lc_material_parse_all',
    description:
      '批量解析：把材料清单里所有可解析文件一次过一遍（可按扩展名过滤、可限条数）。' +
      '单份失败不影响其他份，失败原因与降级原因逐条带回。用于「一堆 PDF 读不完」的场景。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      kind: { type: 'string', description: '只解析这个扩展名，如 pdf / docx / xlsx（不传=全部可解析的）' },
      limit: { type: 'number', description: '本次最多解析几份，默认 50' },
      force: { type: 'boolean', description: '内容未变也重新解析' },
      pdfEngine: { type: 'string', description: 'PDF 引擎：auto（默认）/ mineru / ocr' },
      tier: { type: 'string', description: 'MinerU 档位，默认 basic' },
    },
    execute: async (args) => parseAll(args),
  },
]

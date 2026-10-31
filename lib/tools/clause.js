import { indexClauses, addNote, listNotes, deleteNote, buildReport, VAGUE, NOTE_LEVELS, contractCandidates, reviewWorksheet, validateDrafts, loadDrafts, clearDrafts, ruleClause, loadRulings, rulingStatus, skipContract, loadSkipped } from '../core/clause.js'
import { draftSkill } from './skill.js'
import { reviseContract } from '../core/redline.js'

/** 合同审核：条款索引 → 条款级意见 → 审核报告（M8） */
export const clauseTools = [
  {
    name: 'lc_clause_index',
    description:
      '把合同 docx 按「第X条」切成条款索引，存进案件。之后每条审核意见都要指向具体条款编号。只读源文件，不改它。' +
      'file 优先传材料编号（如 M1）——材料台账里已有的合同不必去查绝对路径；也接受绝对路径或相对案件目录的路径。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      file: {
        type: 'string',
        required: true,
        description: '材料编号（如 M1）、绝对路径，或相对案件目录的路径。文件名唯一时也可直接给文件名。',
      },
    },
    execute: async (args) => indexClauses(args),
  },
  {
    name: 'lc_clause_candidates',
    description:
      '列出材料台账里可以索引为合同的 docx，标出哪些已索引。要审合同先调它——别让用户去查路径。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
    },
    execute: async (args) => {
      const items = contractCandidates({ case: args.case })
      // 「还没决定」才需要人动手；明确跳过的不再计入待办
      const pending = items.filter((x) => !x.indexed && !x.skipped).length
      const skipped = items.filter((x) => x.skipped).length
      return {
        ok: true,
        total: items.length,
        pending,
        skipped,
        items,
        summary: items.length
          ? `材料里有 ${items.length} 份 docx：已索引 ${items.filter((x) => x.indexed).length}，待决定 ${pending}，明确不索引 ${skipped}`
          : '材料台账里没有 .docx',
      }
    },
  },
  {
    name: 'lc_clause_skip',
    description:
      '标记「这份合同不索引 / 不审」——用于收口那些永远切不出条款的附件（劳动合同、居间协议、保密承诺），' +
      '或这次根本不审的合同。标记后它不再出现在待索引里，「索引条款」这一步就能真正走完。' +
      '必须写理由。unskip=true 可反悔；已索引过的要先 lc_clause_unindex。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      file: { type: 'string', required: true, description: '材料编号（如 M3）、绝对路径或文件名' },
      reason: { type: 'string', description: '为什么不索引（≥2 字，必填，除非 unskip=true）' },
      unskip: { type: 'boolean', description: '撤销「不索引」，恢复成待索引' },
    },
    execute: async (args) => skipContract(args),
  },
  {
    name: 'lc_clause_unindex',
    description: '取消一份合同已有的条款索引（与「不索引」互斥）。用于索引错了文件、或这份不再审。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      file: { type: 'string', required: true, description: '材料编号、绝对路径或文件名' },
    },
    execute: async (args) => {
      const { unindexClauses } = await import('../core/clause.js')
      return unindexClauses(args)
    },
  },
  {
    name: 'lc_note_worksheet',
    description:
      '列出全部待审条款 + 每条可直接逐字引用的原文句子。要批量预生成审核意见时先调它——' +
      '引文必须逐字命中条款原文，从这里选句子能保证命中，凭记忆抄会被拒收。纯读。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      file: { type: 'string', description: '合同文件名（多份合同时指定）' },
    },
    execute: async (args) => reviewWorksheet(args),
  },
  {
    name: 'lc_note_validate',
    description:
      '校验一批审核意见草稿能不能落地：引文是否逐字命中、有无空泛话术、三要素是否齐全。**不写台账**。' +
      'AI 批量预生成后先用它自查，改掉不合格的再交给人勾选采纳。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      file: { type: 'string', description: '合同文件名（多份合同时指定）' },
      drafts: { type: 'string', required: true, description: '草稿数组的 JSON 字符串：[{clause,level,issue,fix,quote,basis}]' },
      save: { type: 'boolean', description: 'true=同时记成案件里的 AI 草稿，面板会摆出来让人勾选（仍不写台账）' },
    },
    execute: async (args) => {
      let drafts = args.drafts
      if (typeof drafts === 'string') {
        try {
          drafts = JSON.parse(drafts)
        } catch (e) {
          throw new Error('drafts 不是合法 JSON：' + e.message)
        }
      }
      return validateDrafts({ case: args.case, file: args.file, drafts, save: Boolean(args.save) })
    },
  },
  {
    name: 'lc_note_drafts',
    description: '读回/清空案件里暂存的 AI 草稿（.lawcase/note-drafts.json）。action=list 读回，clear 清空。纯本地，不写台账。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      action: { type: 'string', description: 'list（默认）/ clear' },
    },
    execute: async (args) =>
      String(args.action || 'list') === 'clear' ? clearDrafts({ case: args.case }) : loadDrafts({ case: args.case }),
  },
  {
    name: 'lc_clause_rule',
    description:
      '记一条条款审核判定：norevision（已审·无需修改，必须给理由）/ revision（已审·需修改，意见另用 lc_note_add）。' +
      '「丢弃 AI 草稿」在业务上就是这个动作——留痕才分得清「看过没问题」和「漏审」。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      clause: { type: 'string', required: true, description: '条款编号' },
      kind: { type: 'string', required: true, description: 'norevision / revision' },
      reason: { type: 'string', description: '理由（norevision 必填，≥4 字）' },
      file: { type: 'string', description: '合同文件名' },
      by: { type: 'string', description: '判定人' },
    },
    execute: async (args) => ruleClause(args),
  },
  {
    name: 'lc_clause_rulings',
    description: '看条款审核进度：哪些条款已处理（有判定或有意见）、哪些还没审。纯读。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      file: { type: 'string', description: '合同文件名' },
    },
    execute: async (args) => rulingStatus(args),
  },
  {
    name: 'lc_note_add',
    description:
      '登记一条条款级审核意见。必须指到具体条款、说清问题、给出可直接替换的条文。' +
      '含「进一步明确/予以完善/酌情/加强」等空泛表述会被拒收。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      clause: { type: 'string', required: true, description: '条款编号，如「第五条」' },
      level: { type: 'string', description: `风险级别：${NOTE_LEVELS.join(' / ')}，默认重大风险` },
      issue: { type: 'string', required: true, description: '问题：哪句话导致什么后果（≥15字）' },
      fix: { type: 'string', required: true, description: '修改方案：可直接替换的条文（≥15字）' },
      basis: { type: 'string', description: '依据：法条/惯例/对价失衡说明' },
      file: { type: 'string', description: '合同文件名（多份合同时指定）' },
      apply: {
        type: 'string',
        enum: ['comment', 'redline'],
        description:
          '这条意见在 Word 里怎么落：comment（默认）=正文一个字不动、只挂批注（对外发意见稿用这个）；' +
          'redline=正文画红色删除线并写入新条文（"我们已改好的稿子"用这个）。同一条款可逐条切换。',
      },
    },
    execute: async (args) => addNote(args),
  },
  {
    name: 'lc_note_list',
    description: '看已登记的审核意见：条数、按级别分布、逐条内容。纯读。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
    },
    execute: async (args) => listNotes(args),
  },
  {
    name: 'lc_note_delete',
    description: '作废一条审核意见（追加记录，不删原始行，可审计）。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      id: { type: 'string', required: true, description: '意见编号，如 N1' },
    },
    execute: async (args) => deleteNote(args),
  },
  {
    name: 'lc_skill_draft',
    description:
      '把一次审核沉淀成 Skill（四件套：检查清单≤12 项、统一口径、输出模板、禁区≥3 条）。' +
      '清单项必须写「检查什么」+「什么算不过」，缺一不收；写成空泛表述会被拒。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      name: { type: 'string', required: true, description: 'Skill 名称，如「合同审核」' },
      scene: { type: 'string', description: '适用场景说明' },
      items: {
        type: 'array',
        required: true,
        description: '检查清单（1–12 项）',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: '检查项名称' },
            check: { type: 'string', required: true, description: '看哪里、看什么' },
            failSignal: { type: 'string', required: true, description: '什么样的结果算不过' },
          },
        },
      },
      forbidden: {
        type: 'array',
        description: '场景专属禁区（通用禁区已内置 3 条）',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true, description: '禁区内容' },
            why: { type: 'string', description: '为什么禁' },
          },
        },
      },
    },
    execute: async (args) => draftSkill(args),
  },
  {
    name: 'lc_contract_revise',
    description:
      '按已登记的审核意见生成带修订痕迹**并带 Word 批注**的合同（.docx）：' +
      '正文仍是「原文红色删除线 + 新文红色下划线」，同时在每条条款右侧挂一个批注框，' +
      '写明「条款号 · 风险级别 / 问题 / 建议 / 依据」——批注回答"为什么改"，红线回答"改了什么"。' +
      '不传 noteIds 则落实全部意见。原合同只读，输出写到案件 out/。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      file: { type: 'string', description: '合同文件名（多份合同时指定）' },
      noteIds: { type: 'array', description: '只落实这几条意见（如 ["N1","N2"]），不传=全部', items: { type: 'string' } },
      comments: {
        type: 'boolean',
        description: '是否写批注（默认 true）。只有确实需要一份"干净的红线稿"时才传 false',
      },
    },
    execute: async (args) => reviseContract(args),
  },
  {
    name: 'lc_contract_report',
    description: '生成合同审核意见表（Markdown），写到案件 out/ 目录。没有意见时拒绝出空表。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
    },
    execute: async (args) => buildReport(args),
  },
]

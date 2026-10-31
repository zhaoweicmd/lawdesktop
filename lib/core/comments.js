/**
 * comments.js — 给修订版 docx 写入 Word 批注（w:comment）。
 *
 * 为什么现在才加：
 *   2.4x 的修订版刻意用「原文红色删除线 + 新文红色下划线」的**静态格式**，
 *   因为 Word 修订标记在 WPS/Pages 里表现不一。但那套格式只说明了"改了什么"，
 *   没说"为什么改、风险多大"。批注补的正是这一层。
 *
 * OOXML 批注需要四个部分互相配合，缺一个 Word 就会报"内容无法读取"：
 *   ① word/comments.xml          —— 批注正文
 *   ② [Content_Types].xml        —— 给 comments.xml 注册 Override
 *   ③ word/_rels/document.xml.rels —— 从正文指向 comments 的关系
 *   ④ word/document.xml          —— commentRangeStart / commentReference / commentRangeEnd
 *
 * 锚点策略（关键取舍）：
 *   批注范围 = 该条款在**原文**里的起止。因为正文已经被修订过，
 *   所以锚点必须在改正文之前就算好，并且用「插入计数器」换算到改完之后的偏移。
 *   不做这一步就会出现"批注框指向错位文本"——比没有批注更糟。
 */

const AUTHOR = 'LawCase 审核'

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 批注正文里的换行用 <w:br/>，Word 才认 */
function para(text, { bold = false } = {}) {
  const runs = String(text)
    .split('\n')
    .map((line, i) => (i ? '<w:r><w:br/></w:r>' : '') + `<w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r>`)
    .join('')
  const rPr = bold ? '<w:rPr><w:b/></w:rPr>' : ''
  return `<w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>${rPr ? runs.replace(/<w:r>/g, `<w:r>${rPr}`) : runs}</w:p>`
}

/**
 * 组装一条批注的完整正文。
 *
 * 用户口径（2026-11-01）：条款号 + 风险级别 + 问题 + 建议。
 * 风险级别放在第一行，因为审查人横向扫的时候先看严重程度。
 */
export function commentTextFor({ clause, level, issue, fix, basis, fixLabel }) {
  const head = [clause ? `【${clause}】` : '【条款意见】', level ? `${level}` : ''].filter(Boolean).join(' · ')
  const lines = [head]
  if (issue) lines.push(`问题：${String(issue).trim()}`)
  if (fix) lines.push(`${fixLabel || '建议'}：${String(fix).trim()}`)
  if (basis) lines.push(`依据：${String(basis).trim()}`)
  return lines.join('\n')
}

/** comments.xml 全文 */
export function buildCommentsXml(comments, { dateIso } = {}) {
  const d = String(dateIso || new Date().toISOString()).replace(/\.\d+Z$/, 'Z')
  const body = comments
    .map(
      (c) =>
        `<w:comment w:id="${c.id}" w:author="${esc(c.author || AUTHOR)}" w:date="${d}" w:initials="LC">` +
        c.paras.map((p) => para(p)).join('') +
        `</w:comment>`
    )
    .join('')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    body +
    '</w:comments>'
  )
}

/**
 * 在 document.xml 里插入一处批注锚点。
 *
 * 返回新的 XML。锚点插在 `<w:p>` 的**正文开始前**（rangeStart）与**段落结束前**（rangeEnd）。
 * 为什么用段落级而不是精确到某几个字：条款正文的 run 结构千变万化，
 * 精确到字需要重排 run，风险远大于收益；段落级在 Word 里显示为"整段被批注"，正是审查人要的。
 */
export function anchorComment(xml, { start, end, id }) {
  const startTag = `<w:commentRangeStart w:id="${id}"/>`
  const endTag = `<w:commentRangeEnd w:id="${id}"/>`
  const ref = `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`

  const openM = /<w:p(?:\s[^>]*)?>/.exec(xml)
  if (!openM) return xml
  const openEnd = openM.index + openM[0].length
  const withStart = xml.slice(0, openEnd) + startTag + xml.slice(openEnd)

  // 段落闭合处：必须先关范围、再放引用 run，然后才是 </w:p>
  const closeAt = withStart.lastIndexOf('</w:p>')
  if (closeAt < 0) return withStart
  return withStart.slice(0, closeAt) + endTag + ref + withStart.slice(closeAt)
}

/**
 * 注册 comments.xml 需要的三处配套改动。
 *
 * @param {{contentTypes:string, docRels:string, hasCommentsRel?:boolean}} p
 * @returns {{contentTypes:string, docRels:string}}
 */
export function registerComments({ contentTypes, docRels }) {
  const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
  const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'

  let ct = String(contentTypes || '')
  if (!/PartName="\/word\/comments\.xml"/.test(ct)) {
    ct = ct.replace(/<\/Types>/, `<Override PartName="/word/comments.xml" ContentType="${CT}"/></Types>`)
  }

  let rels = String(docRels || '')
  // 关系 id 不能撞车：有的模板已经用到 rId50+
  if (!/relationships\/comments"/.test(rels)) {
    let maxId = 0
    for (const m of rels.matchAll(/Id="rId(\d+)"/g)) maxId = Math.max(maxId, Number(m[1]))
    const id = `rId${maxId + 1}`
    const tag = `<Relationship Id="${id}" Type="${REL_TYPE}" Target="comments.xml"/>`
    // 关系表为空时没有 </Relationships> 之外的挂点，直接塞进去
    rels = rels.includes('</Relationships>')
      ? rels.replace('</Relationships>', `${tag}</Relationships>`)
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${tag}</Relationships>`
  }
  return { contentTypes: ct, docRels: rels }
}

export { AUTHOR }

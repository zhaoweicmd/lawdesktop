// 审核时长与取消：不设墙钟上限，但必须真能取消。
//
// 用户 2026-11-01：
//   「120 秒的审核时间对小合同可能够，但大合同可能不足，不要做这个时间限制」
//
// 去掉上限本身很简单，但它会**暴露一个既有缺陷**：原来的「取消」按钮
// 只改界面状态，后端请求照样在跑。没有上限时，这个缺陷等于
// 「点了取消，模型还在烧钱」。所以这两件事必须一起做，也必须一起测。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { REVIEW_TIMEOUT_MS } from '../lib/core/models.js'
import { callModel } from '../lib/core/llmcall.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('★ 默认不设墙钟上限（120 秒会把大合同掐死）', () => {
  assert.equal(REVIEW_TIMEOUT_MS, 0, '默认超时应为 0（不设）；大合同 120 秒不够')
})

test('timeoutMs=0 时不会起定时器，慢模型能跑完', async () => {
  const t0 = Date.now()
  const r = await callModel({
    llm: {
      // 模拟一个"比 120 秒"更慢的模型（这里用 60ms 代表，重点是不被掐断）
      async *stream() {
        await new Promise((res) => setTimeout(res, 60))
        // 形状要和宿主一致：文本是 text-delta，结束是 {reason:{kind:'stop'}}
        yield { type: 'text-delta', text: '{"issues":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    selection: { provider: 'p', model: 'm' },
    system: 's',
    user: 'u',
    timeoutMs: 0,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(Date.now() - t0 >= 50)
})

test('显式给 timeoutMs 时仍然生效（测试/强制上限场景不能被悄悄取消）', async () => {
  const r = await callModel({
    llm: {
      async *stream({ signal }) {
        await new Promise((res, rej) => {
          const t = setTimeout(res, 500)
          signal.addEventListener('abort', () => {
            clearTimeout(t)
            rej(Object.assign(new Error('aborted'), { code: 'ABORTED' }))
          })
        })
        yield { type: 'text-delta', text: 'x' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    selection: { provider: 'p', model: 'm' },
    system: 's',
    user: 'u',
    timeoutMs: 30,
  })
  assert.equal(r.ok, false)
  assert.match(String(r.code), /timeout|abort/, `应被超时中断，实际 ${r.code}`)
})

test('★ 外部取消（界面「取消」按钮）必须真的中断请求', async () => {
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 30)
  const r = await callModel({
    llm: {
      async *stream({ signal }) {
        await new Promise((res, rej) => {
          const t = setTimeout(res, 5000)
          signal.addEventListener('abort', () => {
            clearTimeout(t)
            rej(Object.assign(new Error('aborted'), { code: 'ABORTED' }))
          })
        })
        yield { type: 'text-delta', text: 'x' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    selection: { provider: 'p', model: 'm' },
    system: 's',
    user: 'u',
    signal: ctrl.signal,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'model/aborted', `取消应返回 aborted，实际 ${r.code}`)
})

test('后端真的登记了取消入口（不是只有前端按钮）', () => {
  const api = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'api.js'), 'utf8')
  assert.match(api, /async 'note\.aiCancel'/, '缺取消接口 ⇒ 点了取消后端还在跑')
  assert.match(api, /new AbortController\(\)/, '必须用 AbortController 才能真正中止')
  assert.match(api, /signal: ctrl\.signal/, 'signal 必须传进 runAiReview')
})

test('同一案件不允许并发两轮审核（否则草稿互相覆盖）', () => {
  const api = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'api.js'), 'utf8')
  assert.match(api, /review\/running/, '并发审核会互相覆盖草稿，必须挡住')
})

// ===== 合同审核案不需要「材料逐条核对」 =====
// 用户 2026-11-01：「合同审核一般只有一个文件；不需要核对」。
// 合同审核的材料是一堆合同/模板/附件，逐份点「已核」没有业务含义。

test('★ 合同审核案：材料不参与核对（11 份材料不该变成 11 条待核）', async () => {
  const { checkStatus } = await import('../lib/core/checkoff.js')
  const { newCase } = await import('../lib/core/case.js')
  const { scanMaterials } = await import('../lib/core/material.js')
  const fs2 = await import('node:fs')
  const os2 = await import('node:os')
  const path2 = await import('node:path')
  const { execFileSync } = await import('node:child_process')

  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'lawcase-ck-'))
  const src = path2.join(root, '卷宗')
  fs2.mkdirSync(src)
  // 造两份 docx + 一个 Word 临时文件
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  const mk = (name) => {
    const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'dx-'))
    fs2.writeFileSync(path2.join(tmp, '[Content_Types].xml'), '<Types/>')
    fs2.mkdirSync(path2.join(tmp, 'word'))
    fs2.mkdirSync(path2.join(tmp, '_rels'))
    fs2.writeFileSync(path2.join(tmp, '_rels', '.rels'), '<Relationships/>')
    fs2.writeFileSync(path2.join(tmp, 'word', 'document.xml'), `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>第一条 价款</w:t></w:r></w:p></w:body></w:document>`)
    execFileSync('zip', ['-qr', path2.join(src, name), '.'.toString()], { cwd: tmp })
  }
  mk('合同.docx')
  mk('模板.docx')
  fs2.writeFileSync(path2.join(src, '~$合同.docx'), '') // Word 临时锁定文件

  const A = path2.join(root, '案')
  newCase({ dir: A, title: '案', caseType: 'contract', materialsDirs: [src] })
  scanMaterials({ case: A, source: src })

  const ck = checkStatus({ case: A })
  assert.ok(!ck.kinds.material, '合同审核案不该有材料核对项')
  assert.equal(ck.total, 0, `材料被算进核对了：${JSON.stringify(ck.kinds)}`)
})

test('Word 临时文件（~$ 开头）不进材料台账', async () => {
  const { scanMaterials, listMaterials } = await import('../lib/core/material.js')
  const { newCase } = await import('../lib/core/case.js')
  const fs2 = await import('node:fs')
  const os2 = await import('node:os')
  const path2 = await import('node:path')

  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'lawcase-skipf-'))
  const src = path2.join(root, '卷宗')
  fs2.mkdirSync(src)
  fs2.writeFileSync(path2.join(src, '~$管理服务合同.doc'), '')
  fs2.writeFileSync(path2.join(src, '真合同.docx'), 'x')
  const A = path2.join(root, '案')
  newCase({ dir: A, title: '案', caseType: 'contract', materialsDirs: [src] })
  scanMaterials({ case: A, source: src })
  const mats = listMaterials({ case: A })
  const names = (mats.files || []).map((f) => f.rel || f.name)
  assert.ok(!names.some((n) => String(n).startsWith('~$')), `临时文件混进台账：${names.join(',')}`)
})

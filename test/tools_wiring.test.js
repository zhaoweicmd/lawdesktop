import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 工具壳静态断链体检。
//
// 背景：lib/tools/review.js 里 lc_review_auto 的 execute 引用了 autoReview，
// 但该文件没有 import 它。ESM 下这不是语法错误，模块能正常加载、工具能正常注册，
// 只有真正调用 execute 时才抛 ReferenceError —— 所以 node --test 里的 core 测试
// 和「能否 import」的检查全都抓不到。这一条专门抓「用了没声明」的符号。
//
// 做法：从 execute 箭头函数体里取被调用的标识符，检查它在同一文件里
// 有 import、有本地 function/const/let 定义，或者是参数/全局白名单成员。

const here = dirname(fileURLToPath(import.meta.url))
const toolsDir = join(here, '..', 'lib', 'tools')

/** 全局白名单：这些名字不需要在文件内声明 */
const GLOBALS = new Set([
  'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date',
  'Promise', 'Error', 'RegExp', 'Map', 'Set', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'console', 'process', 'Buffer', 'setTimeout', 'clearTimeout',
])

/** 收集一个文件里所有「本文件已声明」的顶层名字 */
function declaredNames(src) {
  const names = new Set()
  // import { a, b as c } from '...'
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim()
      if (!seg) continue
      const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)$/)
      names.add(asMatch ? asMatch[1] : seg)
    }
  }
  // import defaultName from '...'
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) {
    names.add(m[1])
  }
  // import * as ns from '...'
  for (const m of src.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1])
  }
  // function foo( / async function foo(
  for (const m of src.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1])
  }
  // const/let/var foo =
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1])
  }
  // const { a, b } = require/destructure
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim().split(':').pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(seg)) names.add(seg)
    }
  }
  // 函数参数：function foo({ a, b }) / function foo(a, b)
  for (const m of src.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim().split(/[:=]/).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(seg)) names.add(seg)
    }
  }
  for (const m of src.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim().split(/[:=]/).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(seg)) names.add(seg)
    }
  }
  return names
}

/** 从 execute 的箭头函数体里取被调用的标识符（形如 X(args) / await X(args)） */
function calledInExecute(src) {
  const found = new Set()
  // execute: async (args) => foo(args)   或   execute: (args, ctx) => { ... foo(...) ... }
  const execBlocks = [...src.matchAll(/execute\s*:\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*(\{[\s\S]*?\n\s*\}|[^\n,]*)/g)]
  for (const block of execBlocks) {
    const body = block[2] || ''
    for (const call of body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = call[1]
      // 跳过语言关键字、动态 import；方法调用已由负向后行断言排除
      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'typeof', 'new', 'function', 'async', 'import'].includes(name)) continue
      found.add(name)
    }
  }
  return found
}

test('工具壳：execute 里调用的每个函数都必须在本文件 import 或定义', async () => {
  const files = (await readdir(toolsDir)).filter((f) => f.endsWith('.js'))
  assert.ok(files.length > 0, '工具壳目录为空，测试本身失效')

  const problems = []
  for (const file of files) {
    const src = await readFile(join(toolsDir, file), 'utf8')
    const declared = declaredNames(src)
    for (const name of calledInExecute(src)) {
      if (declared.has(name) || GLOBALS.has(name)) continue
      problems.push(`${file}: execute 调用了 ${name}()，但本文件没有 import 或定义它`)
    }
  }

  assert.deepEqual(problems, [], `工具壳存在静态断链（调用时才崩）：\n${problems.join('\n')}`)
})

test('工具壳：每个工具都有 name 与 execute，且 name 唯一', async () => {
  const files = (await readdir(toolsDir)).filter((f) => f.endsWith('.js'))
  const seen = new Map()
  for (const file of files) {
    const mod = await import(join(toolsDir, file))
    const arrays = Object.values(mod).filter(Array.isArray)
    for (const arr of arrays) {
      for (const tool of arr) {
        if (!tool || typeof tool !== 'object') continue
        assert.ok(tool.name, `${file} 里有工具缺 name`)
        assert.equal(typeof tool.execute, 'function', `${tool.name} 缺 execute`)
        assert.ok(!seen.has(tool.name), `工具名重复：${tool.name}（${seen.get(tool.name)} 与 ${file}）`)
        seen.set(tool.name, file)
      }
    }
  }
  assert.ok(seen.size >= 48, `工具数偏少：只有 ${seen.size} 个，应有 48 个`)
})

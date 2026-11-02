// 跨平台兼容（为 Windows 交付准备，2026-11-01）
//
// 三类问题在 macOS 上永远试不出来：
//   1. 文件名含 : * ? " < > | —— macOS 合法，Windows 写入失败
//   2. 硬编码 `/usr/bin/xxx` —— Windows 上不存在
//   3. 可执行文件不带扩展名 / X_OK 在 Windows 上恒真 —— which() 会静默找不到
// 这些都不会让 macOS 上的测试变红，所以必须单独测。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { safeFileName, safeJoinName } from '../lib/core/filename.js'
import { which } from '../lib/core/bins.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('★ Windows 禁用字符全部被替换', () => {
  const bad = '采购合同:2026版*修订?版"终稿"<1>|x.docx'
  const out = safeFileName(bad)
  assert.doesNotMatch(out, /[\\/:*?"<>|]/, `残留非法字符：${out}`)
  assert.match(out, /\.docx$/, '扩展名要保留')
})

test('★ 结尾的点和空格必须去掉（Windows 会静默截断）', () => {
  assert.equal(safeFileName('合同...'), '合同')
  assert.equal(safeFileName('合同   '), '合同')
})

test('Windows 保留设备名要加前缀（CON/PRN/AUX/NUL/COM1…）', () => {
  assert.equal(safeFileName('CON.txt'), '_CON.txt')
  assert.equal(safeFileName('nul'), '_nul')
  // 正常名字不能被误改
  assert.equal(safeFileName('console.txt'), 'console.txt')
})

test('按 UTF-8 字节限长（中文一字 3 字节，按字符数算会超）', () => {
  const long = '合'.repeat(200) + '.docx'
  const out = safeFileName(long, { maxBytes: 100 })
  assert.ok(Buffer.byteLength(out, 'utf8') <= 100, `超长：${Buffer.byteLength(out, 'utf8')}`)
  assert.match(out, /\.docx$/, '截断后仍要保留扩展名')
})

test('空名/纯空白给 fallback，不能产出空文件名', () => {
  assert.equal(safeFileName(''), 'file')
  assert.equal(safeFileName('   '), 'file')
  assert.equal(safeJoinName('', '.docx'), 'file.docx')
})

test('反例：正常中文文件名不能被改动', () => {
  for (const n of ['合作投资协议（三方-草案）.docx', '合同审核意见_20261025.md', '修订版_服务合同.docx']) {
    assert.equal(safeFileName(n), n, `误改了正常名：${n}`)
  }
})

test('代码里不许再出现硬编码的 POSIX 路径当"唯一来源"', () => {
  // 允许出现在「按平台判断」的位置，但不允许无条件 path.resolve('/usr/bin/...')
  const files = fs.readdirSync(path.join(ROOT, 'lib', 'core')).filter((f) => f.endsWith('.js'))
  const bad = []
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'core', f), 'utf8')
    for (const line of src.split('\n')) {
      if (/^\s*(const|let)\s+[A-Z_]+\s*=\s*['"]\/(usr|bin|opt|Applications)\//.test(line)) {
        // textutil 是已知例外：doc.js 里按平台判断后才使用
        if (/textutil/.test(line)) continue
        bad.push(`${f}: ${line.trim()}`)
      }
    }
  }
  assert.deepEqual(bad, [], `发现硬编码 POSIX 路径：\n${bad.join('\n')}`)
})

test('which() 在本机能找到 node（跨平台的查找骨架可用）', () => {
  const node = which('node')
  assert.ok(node, 'which(node) 找不到，跨平台查找有问题')
  assert.ok(fs.existsSync(node))
})

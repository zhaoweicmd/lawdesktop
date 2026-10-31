// 目录点选接口（fs.browse）的测试。
//
// 这个 op 存在的意义：界面不再逼用户手打路径，而是点选。
// 所以它必须守住两条底线：① 只读（不建目录、不写文件）；② 只列目录名，不读文件内容。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { browseDir, expandHome, createApi } from '../lib/server/api.js'

function tmpRoot(tag = 'lawcase-browse-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag))
}

test('只列子目录，不列文件和隐藏目录', () => {
  const root = tmpRoot()
  fs.mkdirSync(path.join(root, '甲案'))
  fs.mkdirSync(path.join(root, '乙案'))
  fs.mkdirSync(path.join(root, '.hidden'))
  fs.writeFileSync(path.join(root, '说明.txt'), 'x', 'utf8')

  const out = browseDir({ dir: root })
  assert.equal(out.dir, root)
  assert.deepEqual(out.entries.map((e) => e.name), ['乙案', '甲案'].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
  assert.ok(!out.entries.some((e) => e.name === '.hidden'), '隐藏目录不该出现')
  assert.ok(!out.entries.some((e) => e.name === '说明.txt'), '文件不该出现')
})

test('认出哪一层已经是 LawCase 案件（界面要标「案件」）', () => {
  const root = tmpRoot()
  newCase({ dir: path.join(root, '真案件'), title: '真案件' })
  fs.mkdirSync(path.join(root, '普通目录'))

  const out = browseDir({ dir: root })
  const byName = Object.fromEntries(out.entries.map((e) => [e.name, e]))
  assert.equal(byName['真案件'].hasCase, true)
  assert.equal(byName['普通目录'].hasCase, false)
  assert.equal(out.isCase, false, '根目录自己不是案件')
  assert.equal(browseDir({ dir: path.join(root, '真案件') }).isCase, true)
})

test('传进来的是文件就退到它所在目录，而不是报错', () => {
  const root = tmpRoot()
  const file = path.join(root, 'a.txt')
  fs.writeFileSync(file, 'x', 'utf8')
  const out = browseDir({ dir: file })
  assert.equal(out.dir, root)
})

test('目录不存在 / 空参数给出可执行的报错，不是静默空列表', () => {
  assert.throws(() => browseDir({ dir: path.join(tmpRoot(), '没有这个目录') }), /不存在或不可访问/)
  assert.throws(() => browseDir({}), /请给出要浏览的目录/)
  try {
    browseDir({})
  } catch (e) {
    assert.equal(e.code, 'fs/empty')
  }
})

test('磁盘根没有上一级；普通目录有', () => {
  const root = tmpRoot()
  assert.equal(browseDir({ dir: root }).parent, path.dirname(root))
  assert.equal(browseDir({ dir: path.parse(root).root }).parent, null)
})

test('子目录多时按上限截断并说明，不把界面撑爆', () => {
  const root = tmpRoot()
  for (let i = 0; i < 6; i += 1) fs.mkdirSync(path.join(root, 'd' + i))
  const out = browseDir({ dir: root, limit: 3 })
  assert.equal(out.entries.length, 3)
  assert.equal(out.truncated, true)
  assert.equal(browseDir({ dir: root }).truncated, false)
})

test('fs.browse op：默认从案件根目录起，并给出常用位置', async () => {
  const root = tmpRoot()
  fs.mkdirSync(path.join(root, '案子A'))
  const api = createApi({ version: 't', root, pkgRoot: null })

  const out = await api.handle('fs.browse', {})
  assert.equal(out.ok, true)
  assert.equal(out.data.dir, root, '没传 dir 时从案件根目录起')
  assert.ok(out.data.sections.some((s) => s.label === '案件根目录' && s.path === root))
  assert.ok(out.data.sections.some((s) => s.label === '主目录' && s.path === os.homedir()))
})

test('fs.browse 是只读的：不建目录、不改 ui-state', async () => {
  const root = tmpRoot()
  const pkgRoot = tmpRoot('lawcase-browse-pkg-')
  const api = createApi({ version: 't', root, pkgRoot })
  const before = fs.readdirSync(root).sort()

  await api.handle('fs.browse', { dir: root })
  await api.handle('fs.browse', { dir: path.join(root, '不存在的子目录') })

  assert.deepEqual(fs.readdirSync(root).sort(), before, '浏览不该创建任何东西')
  assert.ok(!fs.existsSync(path.join(pkgRoot, '.lawcase-plugin', 'ui-state.json')), '浏览不该写界面状态')
})

test('fs.browse 传了坏路径要回错误码，让界面能提示', async () => {
  const api = createApi({ version: 't', root: tmpRoot(), pkgRoot: null })
  const out = await api.handle('fs.browse', { dir: '/绝对不存在的路径/xyz' })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'fs/not-found')
})

test('手输 ~ 和 ~/子目录 能认（律师不会背绝对路径）', () => {
  assert.equal(expandHome('~'), os.homedir())
  assert.equal(expandHome('~/'), os.homedir(), 'path.join 会吃掉尾斜杠')
  assert.equal(expandHome('~/Documents/案件'), path.join(os.homedir(), 'Documents/案件'))
  assert.equal(expandHome('/绝对/路径'), '/绝对/路径', '不是 ~ 的原样返回')
  assert.equal(expandHome(''), '')
  assert.equal(expandHome(null), '')
  // 端到端：~ 能定位到主目录（只做 stat，不列目录）
  assert.equal(fs.statSync(expandHome('~')).isDirectory(), true)
})


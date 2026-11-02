// 上架前置检查：包内不得含本机绝对路径 / 密钥 / 客户数据，
// package.json 必须满足工作台市场的安装契约。
// 这些是《工作台市场验收规范》第 3–4 节的硬要求，错了审核直接退。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir, rel = '') {
  const out = []
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.lawcase-plugin' || entry.name === '.git') continue
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(dir, relPath))
    else if (entry.isFile()) out.push(relPath)
  }
  return out
}

test('包内不得出现本机绝对路径（/Users/<name> 或 /home/<name>）', () => {
  const shipped = ['package.json', 'cordis.patch.yml', ...walk(ROOT, 'lib')]
  const offenders = []
  for (const rel of shipped) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    for (const m of text.matchAll(/\/(?:Users|home)\/[A-Za-z0-9._-]+/g)) {
      // 文档里讲"要写绝对路径"的示例不算（比如 /Users/你）
      if (m[0].endsWith('/你')) continue
      offenders.push(`${rel}: ${m[0]}`)
    }
  }
  assert.deepEqual(offenders, [], '包内不允许出现本机绝对路径：\n' + offenders.join('\n'))
})

test('包内不得出现明显的密钥/凭证', () => {
  const shipped = ['package.json', 'cordis.patch.yml', ...walk(ROOT, 'lib')]
  const patterns = [
    /sk-[A-Za-z0-9]{20,}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /AKIA[0-9A-Z]{16}/,
  ]
  const hits = []
  for (const rel of shipped) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    for (const re of patterns) {
      const m = text.match(re)
      if (m) hits.push(`${rel}: ${m[0].slice(0, 12)}…`)
    }
  }
  assert.deepEqual(hits, [], '包内不允许出现密钥：\n' + hits.join('\n'))
})

test('package.json 满足市场的安装契约', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '需要完整 SemVer')
  assert.ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, '必须声明 dsh.bundle.patch')
  assert.ok(pkg.exports && pkg.exports['./client'], '必须导出 ./client')
  assert.ok(fs.existsSync(path.join(ROOT, 'lib', 'client.js')), 'exports["./client"] 必须指向真实文件')
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.license, '必须有许可证')
  // 本地开发版允许 inject 为 []（否则会卡住普通 Harness 的 web boot）；
  // 上架版由 scripts/pack-market.mjs 注入 dsh-desktop-workbenches，见该脚本注释。
  assert.ok(pkg.dsh.client && pkg.dsh.client.platform === 'web', 'dsh.client.platform 必须是 web')
  assert.ok(Array.isArray(pkg.dsh.client.inject), 'dsh.client.inject 必须是数组')
})

test('工作台 register 不声明 id（市场以仓库身份为准）', () => {
  const client = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  // 只看工作台那次 register（侧栏面板的 register 需要 id，不能一起判）
  const m = client.match(/wb\.register\(\s*\{([\s\S]*?)\},\s*Panel\s*\)/)
  assert.ok(m, '应能找到工作台 register 调用')
  const meta = m[1]
  assert.ok(!/\bid\s*:/.test(meta), '工作台 register 的元信息里不应有 id')
  assert.match(meta, /repository:/, '元信息必须带 repository')
  assert.match(meta, /title:/, '元信息必须带 title')
})

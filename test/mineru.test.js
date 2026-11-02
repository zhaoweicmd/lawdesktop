import test from 'node:test'
import assert from 'node:assert'
import { findMineruKit, kitVersionFromPath, classifyMineruError, parsePdfWithMineru, MineruError, TIERS, DEFAULT_TIER } from '../lib/core/mineru.js'

// 这些测试只覆盖「不跑模型」的部分：路径探测、版本解析、错误码归类、参数校验。
// 真正调 mineru-kit 要在真机上跑（见 docs/设计方案_大PDF分片并行解析_v3.md 的验收项），
// 单元测试里跑一次要付 5 秒模型加载，太贵。

test('找 mineru-kit：找不到时返回 null，不抛错', () => {
  const bin = findMineruKit()
  assert.ok(bin === null || typeof bin === 'string')
})

test('从路径抠版本号', () => {
  assert.strictEqual(kitVersionFromPath('/Users/x/opt/mineru-4.0.12/.venv/bin/mineru-kit'), '4.0.12')
  assert.strictEqual(kitVersionFromPath('/Users/x/opt/mineru-4.0/.venv/bin/mineru-kit'), '4.0')
  assert.strictEqual(kitVersionFromPath('/usr/local/bin/mineru-kit'), '')
  assert.strictEqual(kitVersionFromPath(null), '')
})

test('错误码归类：超时 / 档位 / OOM / 缺模块 / 兜底', () => {
  assert.strictEqual(classifyMineruError({ killed: true }, ''), 'parse_timeout')
  assert.strictEqual(classifyMineruError({}, '错误: quality_tier_unavailable'), 'quality_tier_unavailable')
  assert.strictEqual(classifyMineruError({}, 'RuntimeError: parse_oom'), 'parse_oom')
  assert.strictEqual(classifyMineruError({}, "No module named 'mineru.doclib'"), 'engine_unavailable')
  assert.strictEqual(classifyMineruError({}, 'Operation not permitted'), 'engine_unavailable')
  assert.strictEqual(classifyMineruError({}, 'page_range_invalid: 5-3'), 'page_range_invalid')
  assert.strictEqual(classifyMineruError({}, 'something odd'), 'parse_failed')
})

test('档位不合法时当场拒绝，不去启动进程', async () => {
  await assert.rejects(
    () => parsePdfWithMineru('/tmp/nope.pdf', { tier: 'ultra' }),
    (e) => e instanceof MineruError && e.code === 'invalid_request',
  )
  assert.ok(TIERS.includes(DEFAULT_TIER))
  assert.strictEqual(DEFAULT_TIER, 'basic', '默认档位必须是最便宜的 basic：standard 慢数倍且会在空白页产幻觉')
})

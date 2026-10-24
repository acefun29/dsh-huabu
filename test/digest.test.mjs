// C4 摘要注入单测：估算/预算裁剪、未变化为空、节流、agent cwd 缓存与异步预热。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { ProjectDigest, estimateTokens, digestLine, DIGEST_CONTEXT_ORDER } = await import('../lib/.digest.test.mjs')
const { Assets } = await import('../lib/.assets-service.test.mjs')
const { Project, ProjectService } = await import('../lib/.project-service.test.mjs')
const { summarizeAssets } = await import('../lib/.context-service.test.mjs')

function makeWorkspace(t) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'huabu-digest-'))
  const root = join(parent, 'ws')
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const realRoot = realpathSync.native(root)
  return { root: realRoot, assets: new Assets(new Project(realRoot)) }
}

test('estimateTokens：CJK 每字 1、ASCII ~3 字符 1', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('abc'), 1)
  assert.equal(estimateTokens('abcdef'), 2)
})

test('digestLine：含计数与最近文件；小预算先裁最近列表再硬截', (t) => {
  const ws = makeWorkspace(t)
  writeFileSync(join(ws.root, 'poster.png'), 'x')
  ws.assets.importAsset('poster.png', { tags: ['海报'] })
  writeFileSync(join(ws.root, 'clip.mp4'), 'y')
  ws.assets.importAsset('clip.mp4')
  const summary = summarizeAssets(ws.assets)

  const full = digestLine(summary, 300)
  assert.match(full, /素材库共 2 个文件/)
  assert.match(full, /图 1 \/ 视频 1/)
  assert.match(full, /最近：.+poster\.png|clip\.mp4/)
  assert.ok(estimateTokens(full) <= 300)
  assert.match(full, /huabu_asset_list/)

  const tight = digestLine(summary, 12)
  assert.ok(estimateTokens(tight) <= 12, `紧预算下仍超：${tight}（${estimateTokens(tight)} tok）`)
})

test('ProjectDigest：未变化为空、变化后超节流间隔才注入、空库恒空', (t) => {
  const ws = makeWorkspace(t)
  const digest = new ProjectDigest(new ProjectService(), { budgetTokens: 300, minIntervalMs: 10_000 })
  const agent = { id: 'agent-1' }

  assert.equal(digest.text(agent), '', '无 cwd 缓存时为空')
  digest.noteAgentCwd(agent, ws.root)

  assert.equal(digest.text(agent, 1_000), '', '空库为空')
  writeFileSync(join(ws.root, 'a.png'), 'a')
  ws.assets.importAsset('a.png')

  const first = digest.text(agent, 2_000)
  assert.match(first, /素材库共 1 个文件/)
  assert.equal(digest.text(agent, 3_000), '', '未变化为空')

  writeFileSync(join(ws.root, 'b.png'), 'b')
  ws.assets.importAsset('b.png')
  assert.equal(digest.text(agent, 4_000), '', '变化但仍在节流窗口内为空')
  const second = digest.text(agent, 2_000 + 10_001)
  assert.match(second, /素材库共 2 个文件/)
  assert.equal(digest.text(agent, 2_000 + 10_002), '', '注入后未变化又为空')
})

test('ProjectDigest.warm：异步预热后下一轮可同步取到摘要', async (t) => {
  const ws = makeWorkspace(t)
  writeFileSync(join(ws.root, 'x.png'), 'x')
  ws.assets.importAsset('x.png')
  const digest = new ProjectDigest(new ProjectService())
  const agent = { id: 'agent-2' }
  let seenAgent = null
  assert.equal(digest.text(agent), '')
  await digest.warm(agent, async (a) => {
    seenAgent = a
    return ws.root
  })
  assert.equal(seenAgent, agent, 'warm 把 agent 交给 workingDirectory.ensure')
  assert.match(digest.text(agent), /素材库共 1 个文件/)
  // 已缓存的 agent 不会重复 ensure
  let called = 0
  await digest.warm(agent, async () => {
    called += 1
    return ws.root
  })
  assert.equal(called, 0)
})

test('注册常量：digest order 为有限数且排在 WEB_SURFACE(210) 之后', () => {
  assert.equal(typeof DIGEST_CONTEXT_ORDER, 'number')
  assert.ok(DIGEST_CONTEXT_ORDER > 210)
})

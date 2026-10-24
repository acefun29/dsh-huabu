// C3 素材工具三件套 + huabu_context 单测：参数校验、文本渲染、与真实 Assets 服务的端到端。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { Assets } = await import('../lib/.assets-service.test.mjs')
const { Project } = await import('../lib/.project-service.test.mjs')
const { assembleAssetTools } = await import('../lib/.asset-tools.test.mjs')
const { assembleContextTool } = await import('../lib/.context-tool.test.mjs')
const { summarizeAssets, contextText } = await import('../lib/.context-service.test.mjs')

const EXEC = { agent: { id: 'agent-1' } }

function makeKit(t) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'huabu-asset-tools-'))
  const root = join(parent, 'ws')
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const realRoot = realpathSync.native(root)
  const assets = new Assets(new Project(realRoot))
  // 工具只需要 forExec；测试直接绑定临时工作区
  const service = { forExec: async () => assets }
  const tools = assembleAssetTools({}, service)
  const byName = (name) => {
    const hit = tools.find((tool) => tool.name === name)
    assert.ok(hit, `工具 ${name} 未装配`)
    return hit
  }
  return { root: realRoot, assets, byName, contextTool: assembleContextTool({}, service) }
}

function put(root, rel, content) {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
  return rel
}

test('huabu_asset_list：空库提示与带过滤清单文本', async (t) => {
  const kit = makeKit(t)
  const list = kit.byName('huabu_asset_list')
  const empty = await list.execute({}, EXEC)
  assert.match(empty.text, /素材库为空/)

  put(kit.root, 'src.png', 'img')
  await kit.byName('huabu_asset_import').execute({ path: 'src.png', tags: ['海报'] }, EXEC)
  put(kit.root, 'clip.mp4', 'video-bytes')
  await kit.byName('huabu_asset_import').execute({ path: 'clip.mp4' }, EXEC)

  const all = await list.execute({}, EXEC)
  assert.match(all.text, /画布素材（内置 assets\/） · 2 个/)
  assert.match(all.text, /assets\/images\/src\.png .*#海报/)
  assert.match(all.text, /assets\/video\/clip\.mp4/)

  assert.match((await list.execute({ kind: 'image' }, EXEC)).text, /src\.png/)
  assert.doesNotMatch((await list.execute({ kind: 'image' }, EXEC)).text, /clip\.mp4/)
  assert.match((await list.execute({ tag: '海报' }, EXEC)).text, /src\.png/)
  assert.match((await list.execute({ query: 'CLIP' }, EXEC)).text, /clip\.mp4/)
  await assert.rejects(() => list.execute({ kind: 'nope' }, EXEC), /未知 kind/)
  await assert.rejects(() => list.execute({ limit: 0 }, EXEC), /limit 必须是/)
})

test('huabu_asset_import：归档文本含路径与标签；坏参数可操作报错', async (t) => {
  const kit = makeKit(t)
  const importer = kit.byName('huabu_asset_import')
  put(kit.root, 'draft.png', 'png')
  const result = await importer.execute({ path: 'draft.png', tags: ['#主视觉', 'v2'] }, EXEC)
  assert.equal(result.ok, true)
  assert.match(result.text, /已归档：assets\/images\/draft\.png/)
  assert.match(result.text, /#主视觉 #v2/)
  assert.match(result.text, /源文件保留在 draft\.png/)
  await assert.rejects(() => importer.execute({}, EXEC), /缺少 path/)
  await assert.rejects(() => importer.execute({ path: 'draft.png', tags: '海报' }, EXEC), /tags 必须是字符串数组/)
})

test('huabu_asset_tag：add/set/remove 与缺文件报错', async (t) => {
  const kit = makeKit(t)
  const importer = kit.byName('huabu_asset_import')
  const tag = kit.byName('huabu_asset_tag')
  put(kit.root, 'a.png', 'x')
  await importer.execute({ path: 'a.png' }, EXEC)

  assert.match(await (await tag.execute({ path: 'assets/images/a.png', tags: ['甲'] }, EXEC)).text, /#甲/)
  assert.match(
    await (await tag.execute({ path: 'assets/images/a.png', tags: ['乙'] }, EXEC)).text,
    /#甲 #乙/,
  )
  assert.match(
    await (await tag.execute({ path: 'assets/images/a.png', tags: ['乙'], mode: 'remove' }, EXEC)).text,
    /#甲（共 1 个）/,
  )
  assert.match(
    await (await tag.execute({ path: 'assets/images/a.png', tags: [], mode: 'set' }, EXEC)).text,
    /现在没有标签/,
  )
  await assert.rejects(() => tag.execute({ path: 'assets/images/missing.png', tags: ['x'] }, EXEC), /文件不存在/)
  await assert.rejects(() => tag.execute({ path: 'assets/images/a.png', tags: ['x'], mode: 'append' }, EXEC), /未知 mode/)
})

test('huabu_context：素材摘要 + 画布未启用；scope 过滤', async (t) => {
  const kit = makeKit(t)
  put(kit.root, 'src.png', 'img')
  await kit.byName('huabu_asset_import').execute({ path: 'src.png', tags: ['海报'] }, EXEC)
  const all = await kit.contextTool.execute({}, EXEC)
  assert.match(all.text, /素材库（共 1 个文件）：图片 1/)
  assert.match(all.text, /画布：未启用/)
  const boardOnly = await kit.contextTool.execute({ scope: 'board' }, EXEC)
  assert.doesNotMatch(boardOnly.text, /素材库（共/)
  assert.match(boardOnly.text, /画布：未启用/)
  await assert.rejects(() => kit.contextTool.execute({ scope: 'nope' }, EXEC), /未知 scope/)
})

test('summarizeAssets：计数/最近条目/签名稳定性（C4 未变化判空的依据）', async (t) => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'huabu-summary-'))
  const root = join(parent, 'ws')
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const assets = new Assets(new Project(realpathSync.native(root)))

  const empty = summarizeAssets(assets)
  assert.match(empty.text, /素材库为空/)
  assert.equal(empty.total, 0)

  put(root, 'x.png', 'x')
  assets.importAsset('x.png', { tags: ['t'] })
  const first = summarizeAssets(assets)
  assert.equal(first.total, 1)
  assert.equal(first.counts.image, 1)
  const again = summarizeAssets(assets)
  assert.equal(first.signature, again.signature, '状态未变签名一致')
  assert.match(contextText(assets), /素材库（共 1 个文件）/)
})

test('mediaJobsSummary/contextText：重启中断任务在态势里点名（E3）', (t) => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'huabu-e3-'))
  const root = join(parent, 'ws')
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const assets = new Assets(new Project(realpathSync.native(root)))
  const jobs = [
    { kind: 'video', state: 'failed', error: '应用重启，任务已中断；请重新提交', jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    { kind: 'video', state: 'succeeded', jobId: 'ffffffff-1111-2222-3333-444444444444' },
  ]
  const text = contextText(assets, 'all', jobs)
  assert.match(text, /生成任务：共 2 条/)
  assert.match(text, /重启中断：aaaaaaaa/)
})

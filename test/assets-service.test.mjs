// C2 huabu.assets 服务单测：分类表/清洗规则/归档/命名库/标签索引/搜索。
// 用例口径对齐主仓库 scripts/tags-index-check.mjs（读写契约）与 asset-path-check.mjs（断言真实文件）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  Assets,
  AssetsService,
  categorizeFileName,
  cleanTags,
  dedupeName,
  assetDirForKind,
} = await import('../lib/.assets-service.test.mjs')
const { Project } = await import('../lib/.project-service.test.mjs')

function makeWorkspace(t) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'huabu-assets-'))
  const root = join(parent, 'ws')
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return { parent, root: realpathSync.native(root), project: new Project(root), assets: new Assets(new Project(root)) }
}

function writeFile(root, rel, content) {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

test('分类表：与主仓库 src/shared/assets.ts 同表（含 code 归 documents、兜底 others）', () => {
  assert.equal(categorizeFileName('poster.png').category.dir, 'assets/images')
  assert.equal(categorizeFileName('clip.mp4').kind, 'video')
  assert.equal(categorizeFileName('note.md').category.id, 'doc')
  assert.equal(categorizeFileName('index.ts').kind, 'code')
  assert.equal(categorizeFileName('index.ts').category.id, 'doc')
  assert.equal(categorizeFileName('blob.xyz').kind, 'other')
  assert.equal(categorizeFileName('blob.xyz').category.dir, 'assets/others')
  assert.equal(assetDirForKind('image'), 'assets/images')
  assert.equal(assetDirForKind('audio'), 'assets/audio')
})

test('dedupeName：分秒时间戳后缀（poster.png → poster_HHMMSS.png）', () => {
  const now = new Date(2026, 9, 24, 9, 30, 12)
  assert.equal(dedupeName('poster.png', now), 'poster_093012.png')
  assert.equal(dedupeName('noext', now), 'noext_093012')
})

test('cleanTags：去 # / 去重 / 12 字截断 / 最多 8 条 / 空白丢弃（与主仓库 tagsIndex 同规则）', () => {
  assert.deepEqual(cleanTags(['#海报', ' 海报 ', '海报', 'a'.repeat(20), '', '  ']), ['海报', 'aaaaaaaaaaaa'])
  assert.equal(cleanTags(Array.from({ length: 12 }, (_, i) => `t${i}`)).length, 8)
})

test('importAsset：按分类复制进 assets/，源文件保留（复制语义），可同步打标签', (t) => {
  const ws = makeWorkspace(t)
  writeFile(ws.root, 'incoming/poster.png', 'png-bytes')
  const result = ws.assets.importAsset('incoming/poster.png', { tags: ['#海报', '主视觉'] })
  assert.equal(result.relPath, 'assets/images/poster.png')
  assert.equal(result.kind, 'image')
  assert.equal(result.bytes, 9)
  assert.equal(result.duplicate, false)
  assert.deepEqual(result.tags, ['海报', '主视觉'])
  assert.ok(existsSync(join(ws.root, 'assets/images/poster.png')))
  assert.ok(existsSync(join(ws.root, 'incoming/poster.png')), '归档是复制，源文件不动')
})

test('importAsset：重名加序号永不覆盖（poster.png → poster-2.png，duplicate=true）', (t) => {
  const ws = makeWorkspace(t)
  writeFile(ws.root, 'a/poster.png', 'one')
  writeFile(ws.root, 'b/poster.png', 'two')
  const first = ws.assets.importAsset('a/poster.png')
  const second = ws.assets.importAsset('b/poster.png')
  assert.equal(first.relPath, 'assets/images/poster.png')
  assert.equal(second.relPath, 'assets/images/poster-2.png')
  assert.equal(second.duplicate, true)
  assert.equal(readFileSync(join(ws.root, 'assets/images/poster.png'), 'utf8'), 'one', '既有文件未被覆盖')
})

test('importAsset：源不存在 / 源是目录 / 超大小上限 → 可操作错误', (t) => {
  const ws = makeWorkspace(t)
  assert.throws(() => ws.assets.importAsset('missing.png'), /源文件不存在/)
  mkdirSync(join(ws.root, 'adir'), { recursive: true })
  assert.throws(() => ws.assets.importAsset('adir'), /不是常规文件/)
  writeFile(ws.root, 'big.png', 'x'.repeat(64))
  assert.throws(() => ws.assets.importAsset('big.png', { maxBytes: 16 }), /文件过大/)
})

test('importAsset：命名库在 assets/ 下可写入，映射在白名单外被拒，未知库报可用清单', (t) => {
  const ws = makeWorkspace(t)
  mkdirSync(join(ws.root, '.huabu'), { recursive: true })
  writeFileSync(
    join(ws.root, '.huabu/workspace.json'),
    JSON.stringify({
      version: 1,
      libraries: [
        { id: 'lib-1', name: '海报产出', path: 'assets/海报', isPublic: true },
        { id: 'lib-2', name: '外部库', path: '素材库/外部' },
      ],
      chat: { note: '未知字段必须保留' },
    }),
    'utf8',
  )
  writeFile(ws.root, 'p.png', 'x')
  const intoLib = ws.assets.importAsset('p.png', { library: '海报产出' })
  assert.equal(intoLib.relPath, 'assets/海报/p.png')
  assert.throws(() => ws.assets.importAsset('p.png', { library: '外部库' }), /不在 assets\/\*\* 写白名单/)
  assert.throws(() => ws.assets.importAsset('p.png', { library: '没有的库' }), /素材库不存在：没有的库（可用：海报产出、外部库）/)
  // 库写入不影响 workspace.json 的其他段
  const meta = JSON.parse(readFileSync(join(ws.root, '.huabu/workspace.json'), 'utf8'))
  assert.equal(meta.chat.note, '未知字段必须保留')
})

test('setTags：add/set/remove 三态；空结果删键；落盘 {version,savedAt,tags} 且无 .tmp 残留', (t) => {
  const ws = makeWorkspace(t)
  assert.deepEqual(ws.assets.setTags('assets/images/a.png', ['海报']), ['海报'])
  assert.deepEqual(ws.assets.setTags('assets/images/a.png', ['主视觉']), ['海报', '主视觉'])
  assert.deepEqual(ws.assets.setTags('assets/images/a.png', ['海报'], 'remove'), ['主视觉'])
  assert.deepEqual(ws.assets.setTags('assets/images/a.png', ['a', 'b'], 'set'), ['a', 'b'])
  assert.deepEqual(ws.assets.setTags('assets/images/a.png', ['a', 'b'], 'remove'), [])
  assert.equal(ws.assets.loadTags()['assets/images/a.png'], undefined, '空标签 = 删除条目')
  ws.assets.setTags('assets/images/keep.png', ['留'])
  const file = join(ws.root, '.huabu/tags.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.version, 1)
  assert.ok(typeof saved.savedAt === 'string')
  assert.deepEqual(saved.tags, { 'assets/images/keep.png': ['留'] })
  assert.ok(!readdirSync(join(ws.root, '.huabu')).some((n) => n.includes('.tmp')), '不留 tmp 残留')
})

test('loadTags：损坏 JSON 回退空索引不抛；反斜杠键归一成 POSIX', (t) => {
  const ws = makeWorkspace(t)
  mkdirSync(join(ws.root, '.huabu'), { recursive: true })
  writeFileSync(join(ws.root, '.huabu/tags.json'), '{broken json')
  assert.deepEqual(ws.assets.loadTags(), {})
  writeFileSync(
    join(ws.root, '.huabu/tags.json'),
    JSON.stringify({ version: 1, tags: { 'assets\\images\\win.png': ['x'] } }),
  )
  assert.deepEqual(ws.assets.loadTags(), { 'assets/images/win.png': ['x'] })
})

test('list：内置库 + 命名库分组；kind/tag/query 过滤；limit 截断并标记 truncated', (t) => {
  const ws = makeWorkspace(t)
  mkdirSync(join(ws.root, '.huabu'), { recursive: true })
  writeFileSync(
    join(ws.root, '.huabu/workspace.json'),
    JSON.stringify({ version: 1, libraries: [{ id: 'lib-1', name: '海报产出', path: 'assets/海报' }] }),
  )
  writeFile(ws.root, 'src.png', 'img')
  ws.assets.importAsset('src.png', { tags: ['海报'] })
  writeFile(ws.root, 'src.mp4', 'vid')
  ws.assets.importAsset('src.mp4')
  writeFile(ws.root, 'plan.md', 'doc')
  ws.assets.importAsset('plan.md')
  writeFile(ws.root, 'p2.png', 'img2')
  ws.assets.importAsset('p2.png', { library: '海报产出' })
  writeFile(ws.root, 'assets/images/.hidden.png', 'x')

  const all = ws.assets.list()
  assert.equal(all.total, 4)
  const names = all.libraries.flatMap((l) => l.files.map((f) => `${l.name}:${f.relPath}`))
  assert.deepEqual(names.sort(), [
    '海报产出:assets/海报/p2.png',
    '画布素材:assets/documents/plan.md',
    '画布素材:assets/images/src.png',
    '画布素材:assets/video/src.mp4',
  ])
  assert.ok(!names.some((n) => n.includes('.hidden')), '点开头文件不列')

  assert.equal(ws.assets.list({ kind: 'image' }).total, 2)
  assert.equal(ws.assets.list({ tag: '#海报' }).total, 1)
  assert.equal(ws.assets.list({ query: 'PLAN' }).total, 1)
  const limited = ws.assets.list({ limit: 2 })
  assert.equal(limited.total, 2)
  assert.equal(limited.truncated, true)
})

test('list：标签与条目联动（先 setTags 再 list 能查到）', (t) => {
  const ws = makeWorkspace(t)
  writeFile(ws.root, 'src.png', 'img')
  const imported = ws.assets.importAsset('src.png')
  assert.deepEqual(imported.tags, [])
  ws.assets.setTags(imported.relPath, ['v2 改稿'])
  const hit = ws.assets.list({ tag: 'v2 改稿' })
  assert.equal(hit.total, 1)
  assert.equal(hit.libraries[0].files[0].relPath, imported.relPath)
})

test('AssetsService.forExec：走 workingDirectory.ensure 取会话 cwd，忽略 exec.cwd', async (t) => {
  const ws = makeWorkspace(t)
  const service = new AssetsService()
  const assets = await service.forExec(
    { workingDirectory: { ensure: async () => ws.root } },
    { agent: { id: 'agent-1' }, cwd: 'C:\\elsewhere' },
  )
  assert.equal(assets.project.root, ws.root)
})

test('assets.ts 源码不引用 electron（服务层只依赖纯 Node）', () => {
  const source = readFileSync(new URL('../src/services/assets.ts', import.meta.url), 'utf8')
  assert.ok(!/from\s+['"]electron['"]/.test(source), 'assets 服务不得依赖 electron')
})

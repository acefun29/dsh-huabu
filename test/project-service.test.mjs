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
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { Project, ProjectService } = await import('../lib/.project-service.test.mjs')

const META = join('.huabu', 'workspace.json')

function makeWorkspace(t) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'huabu-project-'))
  const root = join(parent, 'ws')
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return { parent, root: realpathSync.native(root), project: new Project(root) }
}

function writeMeta(root, value) {
  mkdirSync(join(root, '.huabu'), { recursive: true })
  writeFileSync(join(root, META), typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

function readMetaRaw(root) {
  return JSON.parse(readFileSync(join(root, META), 'utf8'))
}

test('ProjectService.forExec：走 workingDirectory.ensure，忽略 exec.cwd', async (t) => {
  const ws = makeWorkspace(t)
  const service = new ProjectService()
  let seenAgent = null
  let seenSignal = null
  const signal = new AbortController().signal
  const project = await service.forExec(
    {
      workingDirectory: {
        async ensure(agent, sig) {
          seenAgent = agent
          seenSignal = sig
          return ws.root
        },
      },
    },
    { agent: { id: 'agent-1' }, signal, cwd: 'C:\\somewhere-else' },
  )
  assert.equal(project.root, ws.root)
  assert.equal(seenAgent.id, 'agent-1')
  assert.equal(seenSignal, signal)
})

test('ProjectService.forExec：缺 workingDirectory / agent 时报可操作错误', async (t) => {
  const ws = makeWorkspace(t)
  const service = new ProjectService()
  await assert.rejects(
    () => service.forExec({}, { agent: {} }),
    /workingDirectory 服务不可用/,
  )
  await assert.rejects(
    () => service.forExec({ workingDirectory: { ensure: async () => ws.root } }, {}),
    /没有 agent 会话/,
  )
})

test('Project.open：不存在的目录 / 文件路径直接拒绝', (t) => {
  const ws = makeWorkspace(t)
  assert.throws(() => new Project(join(ws.parent, 'missing')), /工作区不存在或不可访问/)
  const file = join(ws.parent, 'file.txt')
  writeFileSync(file, 'x')
  assert.throws(() => new Project(file), /工作区不是目录/)
})

test('readMeta：文件不存在返回 version 1 且不落盘', (t) => {
  const ws = makeWorkspace(t)
  assert.deepEqual(ws.project.readMeta(), { version: 1 })
  assert.equal(existsSync(join(ws.root, META)), false)
  assert.deepEqual(ws.project.getMedia(), {})
})

test('updateMedia：只改 media，其余段与未知字段原样保留', (t) => {
  const ws = makeWorkspace(t)
  const fixture = {
    version: 1,
    chat: { defaultModel: 'm-1', futureChat: { nested: [1, 2] } },
    media: { confirmVideo: false, outputDir: '.huabu/media', futureMedia: { keep: true } },
    skills: { disabled: ['old-skill'] },
    libraries: [{ id: 'lib-1', name: '公共', path: '素材库/公共', isPublic: true }],
    futureTop: { z: [1, 2, 3] },
  }
  writeMeta(ws.root, fixture)

  const returned = ws.project.updateMedia((media) => {
    media.confirmVideo = true
    media.concurrency = 3
  })
  const after = readMetaRaw(ws.root)
  assert.deepEqual(after, returned)
  assert.equal(after.media.confirmVideo, true)
  assert.equal(after.media.concurrency, 3)
  assert.deepEqual(after.media.futureMedia, { keep: true })
  assert.equal(after.media.outputDir, '.huabu/media')
  for (const key of ['version', 'chat', 'skills', 'libraries', 'futureTop']) {
    assert.deepEqual(after[key], fixture[key], `${key} 不应被改写`)
  }
  assert.deepEqual(Object.keys(after).sort(), Object.keys(fixture).sort())
  assert.deepEqual(
    readdirSync(join(ws.root, '.huabu')).filter((name) => name.endsWith('.tmp')),
    [],
    '临时文件不应残留',
  )

  ws.project.updateMedia((media) => ({ ...media, outputDir: 'assets/generated' }))
  assert.equal(readMetaRaw(ws.root).media.outputDir, 'assets/generated')
  assert.deepEqual(readMetaRaw(ws.root).futureTop, { z: [1, 2, 3] })

  ws.project.updateMedia((media) => {
    delete media.concurrency
  })
  const deleted = readMetaRaw(ws.root)
  assert.equal('concurrency' in deleted.media, false)
  assert.equal(deleted.media.confirmVideo, true)
})

test('updateMedia：缺 media 时只新增 media 段，不改其它段', (t) => {
  const ws = makeWorkspace(t)
  writeMeta(ws.root, { version: 1, chat: { defaultModel: 'm-2' }, futureTop: true })
  ws.project.updateMedia((media) => {
    media.accessMode = 'full'
  })
  const after = readMetaRaw(ws.root)
  assert.deepEqual(after, {
    version: 1,
    chat: { defaultModel: 'm-2' },
    futureTop: true,
    media: { accessMode: 'full' },
  })
})

test('updateMedia / readMeta：坏 JSON 抛错且绝不覆盖原文件', (t) => {
  const ws = makeWorkspace(t)
  const broken = '{ "version": 1, "media": { '
  writeMeta(ws.root, broken)
  assert.throws(() => ws.project.readMeta(), /workspace\.json 解析失败/)
  assert.throws(
    () => ws.project.updateMedia((media) => {
      media.confirmVideo = true
    }),
    /workspace\.json 解析失败/,
  )
  assert.equal(readFileSync(join(ws.root, META), 'utf8'), broken)
})

test('readMeta：.bak 恢复——目标缺失时还原，目标存在时清掉陈旧备份', (t) => {
  const ws = makeWorkspace(t)
  writeMeta(ws.root, { version: 1, media: { confirmVideo: false } })
  const target = join(ws.root, META)
  const bak = `${target}.bak`
  writeFileSync(bak, JSON.stringify({ version: 1, media: { confirmVideo: 'from-bak' } }))
  rmSync(target)

  const recovered = ws.project.readMeta()
  assert.equal(recovered.media.confirmVideo, 'from-bak')
  assert.equal(existsSync(target), true)
  assert.equal(existsSync(bak), false)

  writeFileSync(target, JSON.stringify({ version: 1, media: { confirmVideo: 'target' } }))
  writeFileSync(bak, JSON.stringify({ version: 1, media: { confirmVideo: 'stale-bak' } }))
  assert.equal(ws.project.readMeta().media.confirmVideo, 'target')
  assert.equal(existsSync(bak), false)
})

test('resolve：相对路径折叠、反斜杠归一，.. / 绝对路径 / 盘符 / UNC 全部拒绝', (t) => {
  const ws = makeWorkspace(t)
  assert.equal(ws.project.resolve('smoke/a.author.json'), join(ws.root, 'smoke', 'a.author.json'))
  assert.equal(ws.project.resolve('smoke\\a.author.json'), join(ws.root, 'smoke', 'a.author.json'))
  assert.equal(ws.project.resolve('assets/../.huabu/media'), join(ws.root, '.huabu', 'media'))
  assert.equal(ws.project.resolve('./assets//images/x.png'), join(ws.root, 'assets', 'images', 'x.png'))

  for (const bad of ['../x', 'assets/../../x', '/abs/x', 'C:\\abs\\x', 'C:relative', '\\\\server\\share\\x', '', '   ', '.', 'assets/..']) {
    assert.throws(() => ws.project.resolve(bad), /路径|工作区/, `应拒绝：${JSON.stringify(bad)}`)
  }
  assert.throws(() => ws.project.resolve('a\0b'), /非法字符/)
  if (process.platform === 'win32') {
    assert.throws(() => ws.project.resolve('assets/a:b.png'), /备用数据流/)
  }
})

test('resolveWrite：只允许 .huabu/** 与 assets/**，根目录需 allowRoot', (t) => {
  const ws = makeWorkspace(t)
  assert.equal(ws.project.resolveWrite('.huabu/media/a.png'), join(ws.root, '.huabu', 'media', 'a.png'))
  assert.equal(ws.project.resolveWrite('assets/video/a.mp4'), join(ws.root, 'assets', 'video', 'a.mp4'))
  assert.equal(ws.project.resolveWrite('.huabu', { allowRoot: true }), join(ws.root, '.huabu'))
  assert.throws(() => ws.project.resolveWrite('smoke/a.json'), /写入路径只允许/)
  assert.throws(() => ws.project.resolveWrite('notes/a.txt'), /写入路径只允许/)
  assert.throws(() => ws.project.resolveWrite('.huabu'), /必须指向/)
  assert.throws(() => ws.project.resolveWrite('../assets/a.png'), /越出工作区|路径/)
  assert.throws(() => ws.project.resolveWrite('D:\\x'), /绝对路径/)

  assert.equal(ws.project.ensureDir('.huabu/blockout/scene'), join(ws.root, '.huabu', 'blockout', 'scene'))
  assert.equal(ws.project.ensureDir('assets/video'), join(ws.root, 'assets', 'video'))
  assert.equal(existsSync(join(ws.root, '.huabu', 'blockout', 'scene')), true)
  assert.throws(() => ws.project.ensureDir('notes'), /写入路径只允许/)
})

test('软链逃逸：指向工作区外被拒，指向工作区内可解析', (t) => {
  const ws = makeWorkspace(t)
  const outside = join(ws.parent, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  mkdirSync(join(ws.root, 'assets'), { recursive: true })
  mkdirSync(join(ws.root, 'assets', 'images'), { recursive: true })
  try {
    symlinkSync(outside, join(ws.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(outside, join(ws.root, 'assets', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(join(ws.root, 'assets', 'images'), join(ws.root, 'assets', 'inside'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`当前环境无法创建软链：${error.code ?? error.message}`)
    return
  }
  assert.throws(() => ws.project.resolve('escape/secret.txt'), /越出工作区/)
  assert.throws(() => ws.project.resolveWrite('assets/escape/secret.txt'), /越出工作区/)
  assert.equal(ws.project.resolve('assets/inside/x.png'), join(ws.root, 'assets', 'images', 'x.png'))
})

test('exists：合法路径按实际存在返回，非法路径返回 false', (t) => {
  const ws = makeWorkspace(t)
  mkdirSync(join(ws.root, 'assets'), { recursive: true })
  writeFileSync(join(ws.root, 'assets', 'a.png'), 'x')
  assert.equal(ws.project.exists('assets/a.png'), true)
  assert.equal(ws.project.exists('assets/missing.png'), false)
  assert.equal(ws.project.exists('../outside'), false)
})
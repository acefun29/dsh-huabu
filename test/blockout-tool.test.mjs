import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const {
  assembleBlockoutTool,
  buildEngineArgs,
  insideWorkspace,
  sceneStem,
  assetNameOf,
  imagePathFor,
  BLOCKOUT_ACTIONS,
} = await import('../lib/.blockout-tool.test.mjs')
const { BlockoutService } = await import('../lib/.blockout-service.test.mjs')

const MINI_SCENE = {
  version: 2,
  drivers: { W: 1 },
  defs: {
    cube: {
      parts: [{ id: 'body', shape: 'box', size: ['$W', '$W', '$W'], at: { rest: 'ground' } }],
    },
  },
  scene: [{ use: 'cube', id: 'cube', at: {} }],
}

const BAD_SCENE = {
  version: 2,
  defs: { bad: { parts: [{ id: 'x', shape: 'nope', size: [1, 1, 1], at: { rest: 'ground' } }] } },
  scene: [{ use: 'bad', id: 'bad', at: {} }],
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-huabu-b3-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

async function writeScene(dir, name = 'mini.author.json', scene = MINI_SCENE) {
  const file = join(dir, name)
  await writeFile(file, JSON.stringify(scene), 'utf8')
  return file
}

function execFor(workspaceDir, attachments) {
  const controller = new AbortController()
  return {
    ctx: {
      workingDirectory: {
        async ensure() {
          return workspaceDir
        },
      },
      ...(attachments ? { attachments } : {}),
    },
    exec: { agent: { id: 'agent-b3' }, signal: controller.signal, cwd: 'C:/host/process/cwd' },
  }
}

function fakeAttachments() {
  const calls = []
  return {
    calls,
    service: {
      async saveImage(input) {
        calls.push(input)
        return {
          attachmentId: 'sha256:b4-test',
          mediaType: input.mediaType,
          width: 256,
          height: 256,
          bytes: input.data.length,
          name: input.name,
          ignored: 'not-a-scalar',
        }
      },
    },
  }
}

function fakeService(run) {
  return {
    version: 'test-1',
    timeoutFor: () => 5_000,
    run,
  }
}

function okRun(extra = {}) {
  return {
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: false,
    spawnError: null,
    durationMs: 1,
    progress: [],
    ...extra,
  }
}

test('工具参数是显式 JSON Schema：action 枚举 7 项，required 为 action/scene', () => {
  const tool = assembleBlockoutTool({}, fakeService(async () => okRun()))
  assert.equal(tool.name, 'huabu_blockout')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.properties.action.enum, [...BLOCKOUT_ACTIONS])
  assert.deepEqual(tool.parameters.required, ['action', 'scene'])
  assert.deepEqual(tool.parameters.properties.view.enum, ['front', 'right', 'top', 'threequarter'])
})

test('insideWorkspace：拒绝 ..、绝对越界与工作区根，接受内部相对/绝对路径', () => {
  const ws = join(tmpdir(), 'ws-b3-check')
  assert.equal(insideWorkspace(ws, join(ws, 'sub', 'a.json')), true)
  assert.equal(insideWorkspace(ws, join(ws, 'a.json')), true)
  assert.equal(insideWorkspace(ws, join(ws, '..', 'escape.json')), false)
  assert.equal(insideWorkspace(ws, ws), false)
  assert.equal(insideWorkspace(ws, join(tmpdir(), 'outside.json')), false)
})

test('sceneStem / assetNameOf：去 author 后缀并净化文件名', () => {
  assert.equal(sceneStem('assets/car-on-road.author.json'), 'car-on-road')
  assert.equal(sceneStem('perfume.json'), 'perfume')
  assert.equal(sceneStem('.json'), 'scene')
  assert.equal(assetNameOf('car on/road', 'hero'), 'car-on-road-hero')
})

test('buildEngineArgs：7 个 action 的默认产物路径与参数', () => {
  const ws = join(tmpdir(), 'ws-b3')
  const sceneAbs = join(ws, 'mini.author.json')
  const workDirAbs = join(ws, '.huabu', 'blockout', 'mini')
  const base = { sceneAbs, workDirAbs, keyframes: false }

  assert.deepEqual(buildEngineArgs({ ...base, action: 'check' }), ['check', '--scene', sceneAbs])
  assert.deepEqual(buildEngineArgs({ ...base, action: 'describe' }), ['describe', '--scene', sceneAbs])
  assert.deepEqual(buildEngineArgs({ ...base, action: 'shots' }), ['shots', '--scene', sceneAbs])

  assert.deepEqual(buildEngineArgs({ ...base, action: 'sheet', size: 1024 }), [
    'sheet',
    '--scene',
    sceneAbs,
    '--out',
    join(workDirAbs, 'sheet.png'),
    '--size',
    '1024',
  ])

  assert.deepEqual(buildEngineArgs({ ...base, action: 'view', width: 800, height: 600 }), [
    'view',
    '--scene',
    sceneAbs,
    '--view',
    'threequarter',
    '--out',
    join(workDirAbs, 'view-threequarter.png'),
    '--width',
    '800',
    '--height',
    '600',
  ])

  assert.deepEqual(buildEngineArgs({ ...base, action: 'shot', shot: 'hero' }), [
    'shot',
    '--scene',
    sceneAbs,
    '--shot',
    'hero',
    '--out',
    join(workDirAbs, 'hero.frames.json'),
  ])

  assert.deepEqual(buildEngineArgs({ ...base, action: 'shot', shot: 'hero', keyframes: true, size: 512 }), [
    'shot',
    '--scene',
    sceneAbs,
    '--shot',
    'hero',
    '--sheet',
    '--out',
    join(workDirAbs, 'hero-keys.png'),
    '--size',
    '512',
  ])

  assert.deepEqual(buildEngineArgs({ ...base, action: 'video', shot: 'hero', width: 640, height: 360 }), [
    'video',
    '--scene',
    sceneAbs,
    '--shot',
    'hero',
    '--width',
    '640',
    '--height',
    '360',
    '--out',
    join(workDirAbs, 'hero.mp4'),
    '--progress',
  ])
})

test('imagePathFor：只有 sheet / view / shot(keyframes) 取图，其余为 null', () => {
  const parsed = { image: '/ws/a.png' }
  assert.equal(imagePathFor('sheet', parsed, false), '/ws/a.png')
  assert.equal(imagePathFor('view', parsed, false), '/ws/a.png')
  assert.equal(imagePathFor('shot', parsed, true), '/ws/a.png')
  assert.equal(imagePathFor('shot', parsed, false), null)
  assert.equal(imagePathFor('check', parsed, false), null)
  assert.equal(imagePathFor('describe', parsed, false), null)
  assert.equal(imagePathFor('sheet', null, false), null)
})

test('路径安全带：越界的 scene 与 out 在启动引擎前被拒', async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    await writeScene(ws)
    const outside = await writeScene(dir, 'outside.author.json')
    const { ctx, exec } = execFor(ws)
    const tool = assembleBlockoutTool(ctx, fakeService(async () => okRun({ stdout: '{}' })))

    await assert.rejects(
      () => tool.execute({ action: 'check', scene: '../outside.author.json' }, exec),
      /scene 路径越出工作区/,
    )
    await assert.rejects(
      () => tool.execute({ action: 'check', scene: outside }, exec),
      /scene 路径越出工作区/,
    )
    await assert.rejects(
      () => tool.execute({ action: 'sheet', scene: 'mini.author.json', out: '../sheet.png' }, exec),
      /out 路径越出工作区/,
    )
    await assert.rejects(
      () => tool.execute({ action: 'check', scene: 'missing.author.json' }, exec),
      /场景文件不存在/,
    )
  })
})

test('check：真实引擎返回 JSON 文本结果（exit 0）', async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    await writeScene(ws)
    const { ctx, exec } = execFor(ws)
    const tool = assembleBlockoutTool(ctx, new BlockoutService())

    const value = await tool.execute({ action: 'check', scene: 'mini.author.json' }, exec)
    assert.equal(value.code, 0, value.text)
    assert.equal(value.ok, true)
    assert.match(value.text, /\[blockout engine v0\.2\.0-mvp · check\]/)
    const json = JSON.parse(value.text.slice(value.text.indexOf('\n') + 1))
    assert.equal(json.ok, true)
    assert.equal(json.partCount, 1)
  })
})

test('check：解算 error 以 exit 2 返回文本结果，不抛错', async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    await writeScene(ws, 'bad.author.json', BAD_SCENE)
    const { ctx, exec } = execFor(ws)
    const tool = assembleBlockoutTool(ctx, new BlockoutService())

    const value = await tool.execute({ action: 'check', scene: 'bad.author.json' }, exec)
    assert.equal(value.code, 2)
    assert.equal(value.ok, false)
    assert.match(value.text, /解算有 error/)
    const json = JSON.parse(value.text.slice(value.text.indexOf('\n') + 1))
    assert.equal(json.ok, false)
    assert.match(JSON.stringify(json.errors), /MVP 不支持的图元/)
  })
})

test('sheet：真实引擎把 PNG 落到工作区 .huabu/blockout/<场景>/', async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    await writeScene(ws)
    const { ctx, exec } = execFor(ws)
    const tool = assembleBlockoutTool(ctx, new BlockoutService())

    const value = await tool.execute({ action: 'sheet', scene: 'mini.author.json', size: 256 }, exec)
    assert.equal(value.code, 0, value.text)
    const png = join(ws, '.huabu', 'blockout', 'mini', 'sheet.png')
    assert.equal(existsSync(png), true, `未生成 ${png}`)
    const bytes = await readFile(png)
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '不是 PNG 魔数')
    assert.match(value.text, /"image"/)
  })
})

test('sheet：图片经 saveImage 变成 attachment，render 返回 image block', async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    await writeScene(ws)
    const attachments = fakeAttachments()
    const { ctx, exec } = execFor(ws, attachments.service)
    const tool = assembleBlockoutTool(ctx, new BlockoutService())

    const value = await tool.execute({ action: 'sheet', scene: 'mini.author.json', size: 256 }, exec)
    assert.equal(value.code, 0, value.text)
    assert.equal(attachments.calls.length, 1)
    assert.equal(Buffer.isBuffer(attachments.calls[0].data), true)
    assert.equal(
      attachments.calls[0].data.subarray(0, 8).toString('hex'),
      '89504e470d0a1a0a',
      'saveImage 拿到的不是 PNG',
    )
    assert.equal(attachments.calls[0].mediaType, 'image/png')
    assert.equal(attachments.calls[0].name, 'sheet.png')

    assert.equal(value.images?.length, 1)
    assert.deepEqual(value.images[0], {
      attachmentId: 'sha256:b4-test',
      mediaType: 'image/png',
      name: 'sheet.png',
      width: 256,
      height: 256,
      bytes: attachments.calls[0].data.length,
    })
    assert.match(value.text, /图片已随本条结果附上/)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, '返回值必须可无损 JSON 往返')

    const blocks = tool.output.render({}, value)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[1].type, 'image')
    assert.equal(blocks[1].attachment.attachmentId, 'sha256:b4-test')
  })
})

test('view：单视图同样回喂一张图', async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    await writeScene(ws)
    const attachments = fakeAttachments()
    const { ctx, exec } = execFor(ws, attachments.service)
    const tool = assembleBlockoutTool(ctx, new BlockoutService())

    const value = await tool.execute(
      { action: 'view', scene: 'mini.author.json', view: 'front', width: 256, height: 256 },
      exec,
    )
    assert.equal(value.code, 0, value.text)
    assert.equal(attachments.calls.length, 1)
    assert.equal(attachments.calls[0].name, 'view-front.png')
    assert.equal(value.images?.length, 1)
    assert.equal(existsSync(join(ws, '.huabu', 'blockout', 'mini', 'view-front.png')), true)
  })
})

test('附件服务不可用或抛错：工具仍成功，文本给出降级说明', async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    await writeScene(ws)

    const unavailable = execFor(ws)
    const toolA = assembleBlockoutTool(unavailable.ctx, new BlockoutService())
    const valueA = await toolA.execute({ action: 'sheet', scene: 'mini.author.json', size: 256 }, unavailable.exec)
    assert.equal(valueA.code, 0, valueA.text)
    assert.equal(valueA.images, undefined)
    assert.match(valueA.text, /附件服务不可用/)

    const throwing = execFor(ws, {
      async saveImage() {
        throw new Error('attachment boom')
      },
    })
    const toolB = assembleBlockoutTool(throwing.ctx, new BlockoutService())
    const valueB = await toolB.execute({ action: 'sheet', scene: 'mini.author.json', size: 256 }, throwing.exec)
    assert.equal(valueB.code, 0, valueB.text)
    assert.equal(valueB.images, undefined)
    assert.match(valueB.text, /图片回喂失败：attachment boom/)
  })
})

test('video：默认发布到 assets/video，同镜头重渲染覆盖旧成片', async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    await writeScene(ws)
    const { ctx, exec } = execFor(ws)
    let counter = 0
    const service = fakeService(async (args, options) => {
      const out = args[args.indexOf('--out') + 1]
      await mkdir(dirname(out), { recursive: true })
      counter += 1
      await writeFile(out, `FAKE-MP4-${counter}`)
      return okRun({ stdout: JSON.stringify({ ok: true, video: out, shot: 'hero' }) })
    })
    const tool = assembleBlockoutTool(ctx, service)

    const first = await tool.execute({ action: 'video', scene: 'mini.author.json', shot: 'hero' }, exec)
    assert.equal(first.code, 0, first.text)
    assert.deepEqual(first.published?.relPath, 'assets/video/mini-hero.mp4')
    assert.match(first.text, /成片已发布到素材库/)
    const asset = join(ws, 'assets', 'video', 'mini-hero.mp4')
    assert.equal(await readFile(asset, 'utf8'), 'FAKE-MP4-1')

    const second = await tool.execute({ action: 'video', scene: 'mini.author.json', shot: 'hero' }, exec)
    assert.equal(second.code, 0, second.text)
    assert.equal(await readFile(asset, 'utf8'), 'FAKE-MP4-2')
  })
})

test('video：publish=false 不发布；取消返回 cancelled 文本', async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    await writeScene(ws)
    const { ctx, exec } = execFor(ws)
    const service = fakeService(async (args) => {
      const out = args[args.indexOf('--out') + 1]
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, 'FAKE-MP4')
      return okRun({ stdout: JSON.stringify({ ok: true, video: out, shot: 'hero' }) })
    })
    const tool = assembleBlockoutTool(ctx, service)

    const value = await tool.execute(
      { action: 'video', scene: 'mini.author.json', shot: 'hero', publish: false },
      exec,
    )
    assert.equal(value.code, 0, value.text)
    assert.equal(value.published, undefined)
    assert.equal(existsSync(join(ws, 'assets', 'video', 'mini-hero.mp4')), false)

    const abortedTool = assembleBlockoutTool(
      ctx,
      fakeService(async () => okRun({ code: -1, aborted: true })),
    )
    const aborted = await abortedTool.execute(
      { action: 'video', scene: 'mini.author.json', shot: 'hero' },
      exec,
    )
    assert.equal(aborted.cancelled, true)
    assert.match(aborted.text, /已取消/)
  })
})

test('引擎失败路径：超时抛错、exit 1 透传可操作信息', async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    await writeScene(ws)
    const { ctx, exec } = execFor(ws)

    const timedOut = assembleBlockoutTool(
      ctx,
      fakeService(async () => okRun({ timedOut: true })),
    )
    await assert.rejects(
      () => timedOut.execute({ action: 'sheet', scene: 'mini.author.json' }, exec),
      /超时（5s）/,
    )

    const failed = assembleBlockoutTool(
      ctx,
      fakeService(async () =>
        okRun({ code: 1, stdout: JSON.stringify({ ok: false, message: '未找到 ffmpeg' }) }),
      ),
    )
    await assert.rejects(
      () => failed.execute({ action: 'video', scene: 'mini.author.json', shot: 'hero' }, exec),
      /未找到 ffmpeg/,
    )
  })
})
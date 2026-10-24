// D1 huabu.media 单测：目录校验（catalog:check 口径）、合并层回归、mock 适配器端到端、重启对账。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  MediaService,
  MEDIA_ROOT_REL,
  jobsFileOf,
  BUILTIN_PROVIDERS,
  mergeCatalog,
  PROVIDER_ID_PATTERN,
  MODEL_ID_PATTERN,
  createAdapters,
  getAdapterTypes,
  isRegisteredAdapterType,
} = await import('../lib/.media-service.test.mjs')

/** 插件生效目录 = 内置五家 + mock（与 MediaService.forProject 同一张表） */
const EFFECTIVE_BUILTIN = BUILTIN_PROVIDERS

function makeWorkspace(t) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'huabu-media-'))
  const root = join(parent, 'ws')
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return { parent, root: realpathSync.native(root) }
}

/* ── 1. 目录数据校验（主仓库 scripts/catalog-check.mjs 的口径） ── */

test('目录校验：id 唯一且格式合法、kind 合法、适配器类型已注册、env 命名约定、durations 升序', () => {
  const providerIds = new Set()
  const modelIds = new Set()
  for (const def of EFFECTIVE_BUILTIN) {
    assert.match(def.id, PROVIDER_ID_PATTERN, `provider id 格式：${def.id}`)
    assert.ok(!providerIds.has(def.id), `provider id 重复：${def.id}`)
    providerIds.add(def.id)
    assert.ok(isRegisteredAdapterType(def.adapter), `${def.id}.adapter 未注册：${def.adapter}`)
    assert.match(def.auth.env, /^[A-Z][A-Z0-9]*_KEY$/, `auth.env 命名约定：${def.auth.env}`)
    for (const model of def.models) {
      assert.match(model.id, MODEL_ID_PATTERN, `model id 格式：${model.id}`)
      assert.ok(!modelIds.has(model.id), `model id 重复：${model.id}`)
      modelIds.add(model.id)
      assert.ok(['image', 'video', 'audio'].includes(model.kind), `kind 合法：${model.id}`)
      const durations = model.capabilities?.durations
      if (durations) {
        for (let i = 1; i < durations.length; i += 1) {
          assert.ok(durations[i] > durations[i - 1], `durations 升序：${model.id}`)
        }
      }
    }
  }
  // 五家内置 + 插件 mock 都已注册为适配器
  for (const type of ['gateway-dashscope', 'gateway-volcark', 'gateway-openai-compat', 'gateway-minimax', 'gateway-tencent', 'mock']) {
    assert.ok(getAdapterTypes().includes(type), `适配器未注册：${type}`)
  }
})

test('dry-run：mergeCatalog + createAdapters 全部供应商实例化不抛（零网络）', () => {
  const providers = mergeCatalog(EFFECTIVE_BUILTIN, {})
  assert.ok(providers.length >= 5)
  const adapters = createAdapters(providers, { mediaDir: () => null, resolveKey: async () => undefined })
  assert.equal(adapters.length, providers.length)
  for (const adapter of adapters) {
    assert.equal(typeof adapter.submit, 'function')
    assert.equal(typeof adapter.poll, 'function')
  }
})

test('合并层回归：hiddenBuiltin 隐藏、userProviders 同名覆盖 baseUrl、deprecated 不出现', () => {
  const builtinImage = EFFECTIVE_BUILTIN.flatMap((p) => p.models).find((m) => m.kind === 'image')
  const providers = mergeCatalog(EFFECTIVE_BUILTIN, { hiddenBuiltin: [builtinImage.id] })
  const allModelIds = providers.flatMap((p) => p.models.map((m) => m.id))
  assert.ok(!allModelIds.includes(builtinImage.id), 'hiddenBuiltin 应被隐藏')

  const overridden = mergeCatalog(EFFECTIVE_BUILTIN, {
    userProviders: [
      {
        id: 'dashscope',
        type: 'gateway-dashscope',
        models: { 'test-image': { kind: 'image' } },
      },
    ],
  })
  const dashscope = overridden.find((p) => p.id === 'dashscope')
  assert.ok(dashscope.models.some((m) => m.id === 'dashscope/test-image' || m.id === 'test-image'), '用户模型应并入同名供应商')
  assert.ok(dashscope.models.some((m) => m.id === builtinImage.id), '同名供应商的内置模型保留')

  for (const def of EFFECTIVE_BUILTIN) {
    for (const model of def.models) {
      if (model.status === 'deprecated') {
        assert.ok(!allModelIds.includes(model.id), `deprecated 不应出现：${model.id}`)
      }
    }
  }
})

/* ── 2. MediaService 接线与 mock 端到端 ── */

test('forProject（真实）：providers 含内置与 mock；mediaDir/outputDir 生效', async (t) => {
  const ws = makeWorkspace(t)
  const { Project, ProjectService } = await import('../lib/.project-service.test.mjs')
  const service = new MediaService(new ProjectService())
  const media = service.forProject(new Project(ws.root))
  const ids = media.providers.map((p) => p.id)
  for (const id of ['dashscope', 'volcark', 'openai', 'minimax', 'tencent', 'mock']) {
    assert.ok(ids.includes(id), `providers 缺 ${id}`)
  }
  assert.equal(media.mediaDir, join(ws.root, MEDIA_ROOT_REL))

  // outputDir 覆盖（工作区内合法路径）
  mkdirSync(join(ws.root, '.huabu'), { recursive: true })
  writeFileSync(
    join(ws.root, '.huabu/workspace.json'),
    JSON.stringify({ version: 1, media: { outputDir: 'assets/images' } }),
  )
  const media2 = service.forProject(new Project(ws.root))
  assert.equal(media2.mediaDir, join(ws.root, 'assets', 'images'))
})

test('mock 端到端：submit → poll → 产物 PNG 落盘 + jobs.json 终态 + 对账失效', async (t) => {
  const ws = makeWorkspace(t)
  const { Project, ProjectService } = await import('../lib/.project-service.test.mjs')
  const service = new MediaService(new ProjectService())
  const media = service.forProject(new Project(ws.root))

  const { jobId } = await media.submit({
    kind: 'image',
    provider: 'mock',
    model: 'mock/poster',
    prompt: '深蓝科技海报',
    ratio: '16:9',
    name: 'd1-mock-poster',
  })
  const final = await media.waitForCompletion(jobId)
  assert.equal(final.state, 'succeeded')
  assert.ok(final.artifact, '成功任务应有产物')
  assert.equal(final.artifact.relPath, 'd1-mock-poster.png')
  const artifactAbs = join(media.mediaDir, final.artifact.relPath)
  assert.ok(existsSync(artifactAbs), '产物文件应存在')
  assert.equal(readFileSync(artifactAbs).subarray(0, 4).toString('hex'), '89504e47', '产物应为 PNG')
  assert.equal(final.artifactDirRel, MEDIA_ROOT_REL)

  const ledger = JSON.parse(readFileSync(jobsFileOf(media.mediaDir), 'utf8'))
  assert.equal(ledger.version, 1)
  const saved = ledger.jobs.find((j) => j.jobId === jobId)
  assert.equal(saved.state, 'succeeded')

  // 重启对账：手工塞一条 running 态账本，新服务实例应标 failed（interrupted 语义）
  ledger.jobs.push({
    jobId: 'legacy-running-job',
    provider: 'mock',
    model: 'mock/poster',
    kind: 'image',
    prompt: 'x',
    state: 'running',
    progress: 0.4,
    message: '生成中',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  writeFileSync(jobsFileOf(media.mediaDir), JSON.stringify(ledger, null, 2))
  const fresh = new MediaService(new ProjectService()).forProject(new Project(ws.root))
  const revived = fresh.list().find((j) => j.jobId === 'legacy-running-job')
  assert.equal(revived.state, 'failed')
  assert.match(revived.error, /中断/)
})

test('提交校验：未知 provider / 比例不支持 / kind 不符 → 可操作错误', async (t) => {
  const ws = makeWorkspace(t)
  const { Project, ProjectService } = await import('../lib/.project-service.test.mjs')
  const media = new MediaService(new ProjectService()).forProject(new Project(ws.root))
  await assert.rejects(
    () => media.submit({ kind: 'image', provider: 'nope', model: 'x', prompt: 'p' }),
    /未知媒体 provider：nope/,
  )
  await assert.rejects(
    () => media.submit({ kind: 'image', provider: 'mock', model: 'mock/poster', prompt: 'p', ratio: '21:9' }),
    /不支持比例 21:9/,
  )
  await assert.rejects(
    () => media.submit({ kind: 'video', provider: 'mock', model: 'mock/poster', prompt: 'p' }),
    /不能用于 video/,
  )
  await assert.rejects(
    () => media.submit({ kind: 'image', provider: 'mock', model: 'mock/poster', prompt: '   ' }),
    /提示词不能为空/,
  )
})

test('MediaService.forExec：走 workingDirectory.ensure 取会话 cwd', async (t) => {
  const ws = makeWorkspace(t)
  const service = new MediaService()
  const media = await service.forExec(
    { workingDirectory: { ensure: async () => ws.root } },
    { agent: { id: 'a' }, cwd: 'C:\\elsewhere' },
  )
  assert.equal(media.project.root, ws.root)
})
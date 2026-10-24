// D4 失败路径单测：超时（可注入短超时）、凭据被拒（401 → 可操作指引）、模型不支持参数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { MediaService, MediaJobManager, createAdapters, mergeCatalog, BUILTIN_PROVIDERS } = await import(
  '../lib/.media-service.test.mjs'
)
const { Project, ProjectService } = await import('../lib/.project-service.test.mjs')

function makeWorkspace(t) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'huabu-media-fail-'))
  const root = join(parent, 'ws')
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return realpathSync.native(root)
}

test('超时：轮询永不结束的任务在注入短超时后落 failed（错误文案含超时秒数与建议）', async (t) => {
  const root = makeWorkspace(t)
  const mediaDir = join(root, '.huabu', 'media')
  const forever = {
    id: 'forever',
    type: 'mock',
    label: '永不完成的桩',
    models: [{ id: 'forever/img', kind: 'image', label: 'x', provider: 'forever' }],
    isConfigured: () => true,
    authHint: () => 'stub',
    async submit() {
      return 'job-1'
    },
    async poll() {
      return { status: 'running', progress: 0.4, message: '生成中' }
    },
  }
  const manager = new MediaJobManager(() => undefined, () => ({
    mediaDir,
    workspaceDir: root,
    config: {},
    providers: [],
    adapters: [forever],
    ready: true,
    notifyAssetsChanged: () => undefined,
    timeouts: { image: 500 },
  }))
  const { jobId } = await manager.submit({ kind: 'image', provider: 'forever', model: 'forever/img', prompt: 'x' })
  const final = await manager.waitForCompletion(jobId)
  assert.equal(final.state, 'failed')
  assert.match(final.error, /超时/)
  assert.match(final.error, /0s|1s/)
})

test('凭据被拒：真实网关适配器 401 → 错误文案归因认证并给检查指引', async (t) => {
  const root = makeWorkspace(t)
  const providers = mergeCatalog(BUILTIN_PROVIDERS, {})
  const dashscope = providers.find((p) => p.id === 'dashscope')
  assert.ok(dashscope, '内置目录应含 dashscope')
  const adapters = createAdapters([dashscope], {
    mediaDir: () => join(root, '.huabu', 'media'),
    resolveKey: async () => 'sk-invalid-key',
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 'InvalidApiKey', message: 'Invalid API-key' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const imageModel = adapters[0].models.find((m) => m.kind === 'image')
  assert.ok(imageModel, 'dashscope 应有图片模型')
  await assert.rejects(
    () => adapters[0].submit(imageModel.id, { prompt: 'x' }),
    /认证失败|API Key/,
  )
})

test('模型不支持参数：比例/kind 校验在提交前拒绝（可操作错误列支持列表）', async (t) => {
  const root = makeWorkspace(t)
  const media = new MediaService(new ProjectService()).forProject(new Project(root))
  await assert.rejects(
    () => media.submit({ kind: 'image', provider: 'mock', model: 'mock/poster', prompt: 'p', ratio: '21:9' }),
    /不支持比例 21:9（支持：/,
  )
  await assert.rejects(
    () => media.submit({ kind: 'audio', provider: 'mock', model: 'mock/poster', prompt: 'p' }),
    /不能用于/,
  )
})
// D2 huabu_image_generate 工具单测：参数校验、provider/model 回退链、落库目录、mock 端到端与回喂。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { assembleImageTool, parseImageArgs, resolveAgentMedia, resolveOutputDir, DEFAULT_AGENT_PROVIDER } =
  await import('../lib/.image-tool.test.mjs')
const { MediaService } = await import('../lib/.media-service.test.mjs')
const { Project, ProjectService } = await import('../lib/.project-service.test.mjs')

const EXEC = { agent: { id: 'agent-1' } }

function makeKit(t) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'huabu-image-tool-'))
  const root = join(parent, 'ws')
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const realRoot = realpathSync.native(root)
  const service = new MediaService(new ProjectService())
  const media = service.forProject(new Project(realRoot))
  const savedImages = []
  const attachments = {
    async saveImage(input) {
      savedImages.push(input)
      return { attachmentId: `sha256:fake-${savedImages.length}`, mediaType: input.mediaType, width: 1, height: 1, bytes: input.data.length, name: input.name }
    },
  }
  const tool = assembleImageTool({ attachments }, { forExec: async () => media })
  return { root: realRoot, media, tool, savedImages }
}

test('parseImageArgs：prompt 必填、ratio 枚举、reference_images 数组校验', () => {
  assert.throws(() => parseImageArgs({}), /缺少 prompt/)
  assert.throws(() => parseImageArgs({ prompt: 'x', ratio: '4:5' }), /未知 ratio/)
  assert.throws(() => parseImageArgs({ prompt: 'x', reference_images: 'a.png' }), /必须是字符串数组/)
  const parsed = parseImageArgs({ prompt: ' 海报 ', ratio: '16:9', name: 'hero', reference_images: ['a.png'] })
  assert.equal(parsed.prompt, '海报')
  assert.equal(parsed.ratio, '16:9')
  assert.deepEqual(parsed.referenceImages, ['a.png'])
})

test('resolveAgentMedia：未配置时回退默认供应商 mock；配置 agentModels 优先', (t) => {
  const kit = makeKit(t)
  const resolved = resolveAgentMedia(kit.media, 'image')
  assert.equal(resolved.provider, DEFAULT_AGENT_PROVIDER)
  assert.equal(resolved.model, 'mock/poster')
})

test('resolveOutputDir：默认 assets/images；none 不落库；assets 内命名库生效', (t) => {
  const kit = makeKit(t)
  assert.equal(resolveOutputDir(kit.media, 'image'), 'assets/images')
  mkdirSync(join(kit.root, '.huabu'), { recursive: true })
  writeFileSync(
    join(kit.root, '.huabu/workspace.json'),
    JSON.stringify({
      version: 1,
      media: { defaultLibraryId: 'none' },
      libraries: [{ id: 'lib-1', name: '海报产出', path: 'assets/海报', isPublic: true }],
    }),
  )
  const media2 = new MediaService(new ProjectService()).forProject(new Project(kit.root))
  assert.equal(resolveOutputDir(media2, 'image'), undefined)

  writeFileSync(
    join(kit.root, '.huabu/workspace.json'),
    JSON.stringify({
      version: 1,
      media: { kindLibraryDefaults: { image: 'lib-1' } },
      libraries: [{ id: 'lib-1', name: '海报产出', path: 'assets/海报', isPublic: true }],
    }),
  )
  const media3 = new MediaService(new ProjectService()).forProject(new Project(kit.root))
  assert.equal(resolveOutputDir(media3, 'image'), 'assets/海报')
})

test('端到端：mock 生成 → 产物落 assets/images、attachment 回喂、文本含实际参数', async (t) => {
  const kit = makeKit(t)
  const value = await kit.tool.execute({ prompt: '深蓝科技海报', ratio: '16:9', name: 'd2-hero' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.provider, 'mock')
  assert.match(value.artifactRelPath, /^assets\/images\/d2-hero(-\d+)?\.png$/)
  assert.ok(existsSync(join(kit.root, value.artifactRelPath)), '产物应落素材库目录')
  assert.equal(readFileSync(join(kit.root, value.artifactRelPath)).subarray(0, 4).toString('hex'), '89504e47')
  assert.equal(value.images.length, 1)
  assert.equal(value.images[0].attachmentId, 'sha256:fake-1')
  assert.equal(kit.savedImages.length, 1)
  assert.match(value.text, /生成完成：assets\/images\//)
  assert.match(value.text, /实际 \d+×\d+px/)
  // mock 产物保持请求比例（16:9 → 宽高比 1.777…，±2px 容差）
  const dims = /实际 (\d+)×(\d+)px/.exec(value.text)
  const ratio = Number(dims[1]) / Number(dims[2])
  assert.ok(Math.abs(ratio - 16 / 9) < 0.05, `比例失真：${dims[1]}×${dims[2]}（${ratio}）`)
  // JSON 无损往返（宿主契约 #4）
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('失败路径：参考图不存在 → 可操作错误；附件服务缺失 → 降级文本仍成功', async (t) => {
  const kit = makeKit(t)
  await assert.rejects(
    () => kit.tool.execute({ prompt: 'x', reference_images: ['missing.png'] }, EXEC),
    /参考图不存在：missing\.png/,
  )

  const bareTool = assembleImageTool({}, { forExec: async () => kit.media })
  const value = await bareTool.execute({ prompt: '无附件场景', name: 'd2-noattach' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.images, undefined, '无图时 images 字段应缺省（契约 #4：undefined 不进返回值）')
  assert.match(value.text, /图片未回喂：附件服务不可用/)
  assert.ok(existsSync(join(kit.root, 'assets/images/d2-noattach.png')))
})
// F1-F3 单测：ffmpeg 探测链优先级、元数据解析、skim/frames 工具端到端、缓存命中、区间上限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  VisionService,
  resolveFfmpeg,
  parseFfmpegMeta,
  evenTimeline,
  cachedFrameCount,
  VFRAMES_DIR_REL,
} = await import('../lib/.vision-service.test.mjs')
const { assembleVisionTools, SKIM_FRAME_COUNT, MAX_DETAIL_FRAMES } = await import('../lib/.vision-tool.test.mjs')
const { Project } = await import('../lib/.project-service.test.mjs')

const EXEC = { agent: { id: 'agent-f' } }

function makeKit(t) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'huabu-vision-'))
  const root = join(parent, 'ws')
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const realRoot = realpathSync.native(root)
  const project = new Project(realRoot)
  return { parent, root: realRoot, project }
}

/** 生成测试视频（PATH ffmpeg，lavfi 测试图 4s）；where 不可用时回退直接探测 */
function makeTestVideo(dir, name = 'clip.mp4', seconds = 4) {
  const target = join(dir, name)
  const where = spawnSync('where', ['ffmpeg'], { windowsHide: true })
  const hit = (where.stdout ?? '').toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0]
  let ffmpeg = hit && existsSync(hit) ? hit : undefined
  if (!ffmpeg) {
    const probe = spawnSync('ffmpeg', ['-version'], { windowsHide: true, timeout: 15_000 })
    if (probe.status === 0) ffmpeg = 'ffmpeg'
  }
  if (!ffmpeg) throw new Error('测试环境无 PATH ffmpeg（where 与直接探测均失败）')
  const run = spawnSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=10:duration=${seconds}`, '-pix_fmt', 'yuv420p', target],
    { windowsHide: true, timeout: 60_000 },
  )
  assert.equal(run.status, 0, `生成测试视频失败：${run.stderr}`)
  return target
}

test('F1 探测链：config > env(FFMPEG_PATH) > PATH；探测结果可执行', (t) => {
  const kit = makeKit(t)
  const video = makeTestVideo(kit.parent)
  const byPath = resolveFfmpeg({})
  assert.ok(byPath, '本机应至少能从 PATH 探测到 ffmpeg')
  assert.ok(['env', 'ffmpeg-static', 'PATH'].includes(byPath.source))

  const env = { ...process.env, FFMPEG_PATH: byPath.path }
  const previous = { ...process.env }
  process.env.FFMPEG_PATH = byPath.path
  const byEnv = resolveFfmpeg({})
  assert.equal(byEnv.source, 'env', 'FFMPEG_PATH 环境变量优先于 PATH')
  assert.equal(resolveFfmpeg({ ffmpegPath: byPath.path }).source, 'config', 'config 优先于 env')
  process.env.FFMPEG_PATH = previous.FFMPEG_PATH

  // 探测到的 ffmpeg 能真实解析视频元数据（可执行性）
  const meta = new VisionService().probe(video)
  assert.ok(Math.abs(meta.durationSeconds - 4) < 1, `时长≈4s（实际 ${meta.durationSeconds}）`)
  assert.equal(meta.width, 320)
})

test('parseFfmpegMeta / evenTimeline：纯函数行为', () => {
  const meta = parseFfmpegMeta("  Duration: 00:01:06.50, start: 0.5\n    Stream #0:0: Video: h264 (High), yuv420p, 1280x720, 25 fps")
  assert.equal(meta.durationSeconds, 66.5)
  assert.equal(meta.width, 1280)
  assert.equal(meta.height, 720)
  assert.equal(meta.fps, 25)
  assert.deepEqual(evenTimeline(4, 6), [0, 0.78, 1.56, 2.34, 3.12, 3.9])
  assert.deepEqual(evenTimeline(0, 6), [])
  assert.deepEqual(evenTimeline(4, 1), [0])
})

test('F2 skim 端到端：6 帧回喂 + 元数据/时间轴文本 + vframes 缓存落盘', async (t) => {
  const kit = makeKit(t)
  const video = makeTestVideo(kit.root, 'f2-clip.mp4', 4)
  const saved = []
  const vision = new VisionService()
  const tools = assembleVisionTools(
    { attachments: { async saveImage(input) { saved.push(input); return { attachmentId: `sha256:v-${saved.length}`, mediaType: input.mediaType, width: 1, height: 1, bytes: input.data.length, name: input.name } } } },
    vision,
    async () => kit.project,
  )
  const skim = tools.find((tool) => tool.name === 'huabu_video_skim')
  const value = await skim.execute({ path: 'f2-clip.mp4' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.images.length, SKIM_FRAME_COUNT)
  assert.match(value.text, /时长 4\.0s/)
  assert.match(value.text, /320×180px/)
  assert.match(value.text, new RegExp(`时间轴（${SKIM_FRAME_COUNT}/${SKIM_FRAME_COUNT} 帧`))
  assert.equal(saved.length, SKIM_FRAME_COUNT)
  assert.equal(saved[0].data.subarray(0, 4).toString('hex'), '89504e47', '回喂的是 PNG')
  assert.equal(cachedFrameCount(join(kit.root, VFRAMES_DIR_REL)), SKIM_FRAME_COUNT, '缓存目录应有 6 帧')
})

test('F3 frames 端到端：区间抽帧 → 第二次全缓存命中；参数上限校验', async (t) => {
  const kit = makeKit(t)
  makeTestVideo(kit.root, 'f3-clip.mp4', 4)
  const vision = new VisionService()
  const saved = []
  const tools = assembleVisionTools(
    { attachments: { async saveImage(input) { saved.push(input); return { attachmentId: `sha256:f3-${saved.length}`, mediaType: input.mediaType, width: 1, height: 1, bytes: input.data.length, name: input.name } } } },
    vision,
    async () => kit.project,
  )
  const framesTool = tools.find((tool) => tool.name === 'huabu_video_frames')

  await assert.rejects(
    () => framesTool.execute({ path: 'f3-clip.mp4', start_seconds: 0, end_seconds: 301 }, EXEC),
    new RegExp('区间超上限'),
  )
  await assert.rejects(
    () => framesTool.execute({ path: 'f3-clip.mp4', start_seconds: 0, end_seconds: 2, count: MAX_DETAIL_FRAMES + 1 }, EXEC),
    new RegExp(`1–${MAX_DETAIL_FRAMES}`),
  )
  await assert.rejects(
    () => framesTool.execute({ path: 'missing.mp4', start_seconds: 0, end_seconds: 2 }, EXEC),
    /视频不存在/,
  )

  const first = await framesTool.execute({ path: 'f3-clip.mp4', start_seconds: 0, end_seconds: 2, count: 4 }, EXEC)
  assert.equal(first.images.length, 4)
  assert.match(first.text, /缓存命中 0/)

  const second = await framesTool.execute({ path: 'f3-clip.mp4', start_seconds: 0, end_seconds: 2, count: 4 }, EXEC)
  assert.equal(second.images.length, 4)
  assert.match(second.text, /缓存命中 4/, '同参数重读应全部命中缓存（不再跑 ffmpeg）')
  assert.deepEqual(JSON.parse(JSON.stringify(second)), second, 'JSON 无损往返（契约 #4）')
})

test('附件服务缺失：skim 仍成功（文本说明帧未回喂）', async (t) => {
  const kit = makeKit(t)
  makeTestVideo(kit.root, 'f2-noattach.mp4', 4)
  const tools = assembleVisionTools({}, new VisionService(), async () => kit.project)
  const value = await tools.find((tool) => tool.name === 'huabu_video_skim').execute({ path: 'f2-noattach.mp4' }, EXEC)
  assert.equal(value.ok, true)
  assert.deepEqual(value.images, [])
  assert.match(value.text, /帧未回喂：附件服务不可用/)
})
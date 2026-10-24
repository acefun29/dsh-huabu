// E1/E2/E5 工具单测：确认闸门、jobs 后台路径（含 output 环与取消）、配额上限、mock 视频/音频真产物。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  assembleVideoTool,
  assembleAudioTool,
  parseVideoArgs,
  parseAudioArgs,
  recentSubmissions,
  DEFAULT_MAX_VIDEO_SECONDS,
} = await import('../lib/.video-tool.test.mjs')
const { MediaService } = await import('../lib/.media-service.test.mjs')
const { Project, ProjectService } = await import('../lib/.project-service.test.mjs')

const EXEC = { agent: { id: 'agent-e2e' }, callId: 'call-1', rootCallId: 'root-1' }

function makeKit(t, withJobs = true) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'huabu-video-tool-'))
  const root = join(parent, 'ws')
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const realRoot = realpathSync.native(root)
  const service = new MediaService(new ProjectService())
  const media = service.forProject(new Project(realRoot))
  const started = []
  const jobs = withJobs
    ? {
        start(spec) {
          started.push(spec)
          return `job-${started.length}`
        },
      }
    : undefined
  const ctx = jobs ? { get: (name) => (name === 'jobs' ? jobs : undefined) } : {}
  return {
    root: realRoot,
    media,
    started,
    video: assembleVideoTool(ctx, { forExec: async () => media }),
    audio: assembleAudioTool(ctx, { forExec: async () => media }),
  }
}

test('确认闸门：未带 confirmed 只返回待确认参数，不提交任何任务', async (t) => {
  const kit = makeKit(t)
  const value = await kit.video.execute({ prompt: '城市夜景航拍', duration_seconds: 6, name: 'e2-clip' }, EXEC)
  assert.equal(value.needsConfirm, true)
  assert.match(value.text, /需要用户确认/)
  assert.match(value.text, /时长 6s/)
  assert.equal(value.jobId, undefined)
  assert.equal(kit.started.length, 0, '不得启动 job')
  assert.equal(kit.media.list().length, 0, '不得提交媒体任务')
})

test('确认后走 jobs：立即返回 jobId；run().done 完成时产物为真 MP4、detail 含路径', async (t) => {
  const kit = makeKit(t)
  const value = await kit.video.execute(
    { prompt: '城市夜景航拍', duration_seconds: 4, ratio: '16:9', name: 'e2-clip', confirmed: true },
    EXEC,
  )
  assert.equal(value.ok, true)
  assert.equal(value.jobId, 'job-1')
  assert.equal(kit.started.length, 1)
  assert.match(value.text, /后台任务/)

  const spec = kit.started[0]
  assert.equal(spec.kind, 'huabu-video')
  assert.equal(spec.owner, 'agent-e2e')
  assert.equal(spec.toolCall.callId, 'call-1')
  const handle = spec.run()
  const final = await handle.done
  assert.equal(final.status, 'completed')
  assert.match(final.detail, /assets\/video\/e2-clip\.mp4/)
  const artifact = join(kit.root, 'assets', 'video', 'e2-clip.mp4')
  assert.ok(existsSync(artifact), 'MP4 应落素材库')
  const head = readFileSync(artifact).subarray(4, 12).toString('latin1')
  assert.equal(head.startsWith('ftyp'), true, 'MP4 魔数（ftyp）')

  // output 环：任务结束后从 0 读到全量日志（提交/进度/完成都在）；末端再读为增量空
  const first = spec.output[0].read(0)
  assert.match(first.text, /提交到 mock\/mock\/clip/)
  assert.match(first.text, /完成：/)
  assert.ok(first.nextOffset > 0)
  const delta = spec.output[0].read(first.nextOffset)
  assert.equal(delta.text, '')
})

test('音频走 jobs：WAV 产物（RIFF 魔数）与 detail 路径', async (t) => {
  const kit = makeKit(t)
  const value = await kit.audio.execute({ prompt: '紧张鼓点', duration_seconds: 4, name: 'e5-drum' }, EXEC)
  assert.equal(value.ok, true)
  const handle = kit.started[0].run()
  const final = await handle.done
  assert.equal(final.status, 'completed')
  assert.match(final.detail, /assets\/audio\/e5-drum\.wav/)
  const artifact = join(kit.root, 'assets', 'audio', 'e5-drum.wav')
  assert.ok(existsSync(artifact))
  assert.equal(readFileSync(artifact).subarray(0, 4).toString('latin1'), 'RIFF')
})

test('配额：时长超上限在参数层拒绝（2–60 区间）；近 1 小时提交数正确统计', async (t) => {
  const kit = makeKit(t)
  await assert.rejects(
    () => kit.video.execute({ prompt: 'x', duration_seconds: DEFAULT_MAX_VIDEO_SECONDS + 1, confirmed: true }, EXEC),
    /必须在 2–60 之间/,
  )
  assert.equal(kit.started.length, 0, '超限参数不应启动 job')
  assert.equal(recentSubmissions(kit.media, 'video'), 0)

  const value = await kit.video.execute({ prompt: '配额计数样本', duration_seconds: 4, confirmed: true, name: 'quota' }, EXEC)
  assert.equal(value.ok, true)
  const handle = kit.started[0].run()
  await handle.done
  assert.equal(recentSubmissions(kit.media, 'video'), 1)
})

test('参数校验：首帧与 reference_* 混用拒绝；ratio 枚举', () => {
  assert.throws(
    () => parseVideoArgs({ prompt: 'x', first_frame: 'a.png', reference_images: ['b.png'] }),
    /不能混用/,
  )
  assert.throws(() => parseVideoArgs({ prompt: 'x', ratio: '5:4' }), /未知 ratio/)
  assert.throws(() => parseAudioArgs({}), /缺少 prompt/)
  const parsed = parseVideoArgs({ prompt: 'x', duration_seconds: 6 })
  assert.equal(parsed.durationSeconds, 6)
  assert.equal(parsed.confirmed, false)
})

test('jobs 不可用 → 同步退化：视频完成仍返回路径（文本注明同步模式）', async (t) => {
  const kit = makeKit(t, false)
  const value = await kit.video.execute({ prompt: '同步模式片段', duration_seconds: 4, name: 'e2-sync', confirmed: true }, EXEC)
  assert.equal(value.ok, true)
  assert.match(value.text, /同步模式/)
  assert.match(value.artifactRelPath, /assets\/video\/e2-sync\.mp4/)
})
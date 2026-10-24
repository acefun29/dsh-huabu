// mock 适配器（dsh-huabu 插件侧，上游 42db3cf 移除后按插件需要重写）：
// 无凭据、不联网，本地生成确定性产物——单测与零 Key 环境的端到端演示用。
// 行为契约：submit 立即受理；poll 前 2 次报 running 进度，第 3 次 succeeded 给本地产物。
// 视频 = ffmpeg-static lavfi 测试图（真 MP4）；音频 = 纯 Node 正弦扫频（真 WAV）。
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaProviderAdapter, ProviderPollResult, ProviderSubmitInput } from '../provider'
import type { MediaModelInfo } from '../shared'
import type { AdapterDeps } from './registry'
import { registerAdapter } from './registry'
import { colorOfSeed, gradientPng } from '../png'

const MOCK_MODELS: MediaModelInfo[] = [
  {
    id: 'mock/poster',
    kind: 'image',
    label: 'Mock 海报（本地生成）',
    provider: 'mock',
    capabilities: {
      ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
      refQuota: [{ role: 'reference_image', max: 4 }],
    },
    costHint: '免费（本地像素，不联网）',
  },
  {
    id: 'mock/clip',
    kind: 'video',
    label: 'Mock 短片（ffmpeg 测试图）',
    provider: 'mock',
    capabilities: {
      ratios: ['16:9', '9:16'],
      durations: [4, 6, 8],
      refQuota: [{ role: 'first_frame', max: 1 }],
    },
    costHint: '免费（本地 ffmpeg，不联网）',
  },
  {
    id: 'mock/voice',
    kind: 'audio',
    label: 'Mock 音频（正弦扫频）',
    provider: 'mock',
    capabilities: { durations: [4, 8] },
    costHint: '免费（本地合成，不联网）',
  },
]

interface MockJob {
  prompt: string
  kind: 'image' | 'video' | 'audio'
  width?: number
  height?: number
  durationSeconds?: number
  polls: number
}

export class MockProviderAdapter implements MediaProviderAdapter {
  readonly id = 'mock'
  readonly type = 'mock' as const
  readonly label = 'Mock（本地零成本）'
  readonly models = MOCK_MODELS
  private readonly jobs = new Map<string, MockJob>()

  constructor(private readonly deps?: AdapterDeps) {}

  isConfigured(): boolean {
    return true
  }

  authHint(): string {
    return 'mock（无需凭据）'
  }

  submit(model: string, input: ProviderSubmitInput): Promise<string> {
    const modelDef = this.models.find((m) => m.id === model)
    if (!modelDef) {
      throw new Error(`provider mock 下没有模型 ${model}（只有 ${this.models.map((m) => m.id).join(' / ')}）`)
    }
    const jobId = randomUUID()
    this.jobs.set(jobId, {
      prompt: input.prompt,
      kind: modelDef.kind,
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
      ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
      polls: 0,
    })
    return Promise.resolve(jobId)
  }

  poll(model: string, jobId: string): Promise<ProviderPollResult> {
    const job = this.jobs.get(jobId)
    if (!job) return Promise.resolve({ status: 'failed', message: `mock 任务不存在：${jobId}` })
    job.polls += 1
    if (job.polls < 3) {
      return Promise.resolve({
        status: 'running',
        progress: 0.1 + job.polls * 0.25,
        message: `mock 生成中（${job.polls}/3）`,
      })
    }
    this.jobs.delete(jobId)
    const kind = job.kind
    if (kind === 'video') return this.mockVideo(job, jobId)
    if (kind === 'audio') return Promise.resolve(this.mockAudio(job, jobId))
    return Promise.resolve(this.mockImage(job, jobId))
  }

  private tempFile(jobId: string): { dir: string; file: (ext: string) => string } {
    const base = this.deps?.mediaDir() ?? tmpdir()
    const dir = join(base, '.mock-tmp')
    mkdirSync(dir, { recursive: true })
    return { dir, file: (ext: string) => join(dir, `${jobId}${ext}`) }
  }

  private mockImage(job: MockJob, jobId: string): ProviderPollResult {
    // 保持请求宽高比（比例参数经编排层换算成 width/height 传入）；边长只做上限钳制
    const aspect = job.width && job.height ? job.height / job.width : 9 / 16
    const width = Math.min(1024, Math.max(256, job.width ?? 1024))
    const height = Math.max(128, Math.round(width * aspect))
    // prompt 决定配色：两次不同 prompt 肉眼可区分；同 prompt 结果确定
    const png = gradientPng(width, height, colorOfSeed(job.prompt), colorOfSeed(`${job.prompt}#bottom`))
    const { file } = this.tempFile(jobId)
    const target = file('.png')
    writeFileSync(target, png)
    return { status: 'succeeded', resultFile: target, fileExt: '.png', mime: 'image/png' }
  }

  private async mockVideo(job: MockJob, jobId: string): Promise<ProviderPollResult> {
    // ffmpeg-static 的 lavfi 测试图：可播放的真 MP4（进度条/时长/截图都正常）
    const seconds = Math.min(10, Math.max(2, Math.round(job.durationSeconds ?? 4)))
    const color = colorOfSeed(job.prompt)
    const hex = [color[0], color[1], color[2]].map((v) => v.toString(16).padStart(2, '0')).join('')
    const { file } = this.tempFile(jobId)
    const target = file('.mp4')
    let ffmpeg: string | undefined
    try {
      // ffmpeg-static 是 optionalDependency，动态 import + 构建期 external（B2 同款手法）；
      // 二进制可能未随 postinstall 下载（existsSync 校验），缺省回退 PATH 上的 ffmpeg
      const mod = (await import('ffmpeg-static')) as unknown as { default?: string } | string
      const candidate = typeof mod === 'string' ? mod : mod.default
      if (candidate && existsSync(candidate)) ffmpeg = candidate
    } catch {
      ffmpeg = undefined
    }
    if (!ffmpeg) ffmpeg = 'ffmpeg'
    const run = spawnSync(
      ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=10:duration=${seconds}`,
        '-f', 'lavfi', '-i', `color=c=0x${hex}@0.35:size=320x180:rate=10:duration=${seconds}`,
        '-filter_complex', 'blend=all_mode=screen',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        target,
      ],
      { windowsHide: true, timeout: 60_000 },
    )
    if (run.error || run.status !== 0) {
      const detail = run.error ? run.error.message : (run.stderr || '').toString().slice(0, 200)
      return {
        status: 'failed',
        message: `mock 视频渲染失败（${detail || '无输出'}）：请安装 ffmpeg（PATH 可见）或插件依赖 ffmpeg-static 后重试`,
      }
    }
    return { status: 'succeeded', resultFile: target, fileExt: '.mp4', mime: 'video/mp4', durationSeconds: seconds }
  }

  private mockAudio(job: MockJob, jobId: string): ProviderPollResult {
    // 纯 Node 正弦扫频 WAV（16bit PCM 单声道）：任何播放器可放
    const seconds = Math.min(10, Math.max(2, Math.round(job.durationSeconds ?? 4)))
    const rate = 8000
    const samples = seconds * rate
    const data = Buffer.alloc(samples * 2)
    const base = 60 + (colorOfSeed(job.prompt)[0] % 400)
    for (let i = 0; i < samples; i += 1) {
      const t = i / rate
      const freq = base + (i / samples) * 600
      const envelope = 0.6 * (1 - t / seconds / 2)
      const value = Math.sin(2 * Math.PI * freq * t) * envelope
      data.writeInt16LE(Math.round(value * 32767 * 0.5), i * 2)
    }
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + data.length, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(rate, 24)
    header.writeUInt32LE(rate * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(data.length, 40)
    const { file } = this.tempFile(jobId)
    const target = file('.wav')
    writeFileSync(target, Buffer.concat([header, data]))
    return { status: 'succeeded', resultFile: target, fileExt: '.wav', mime: 'audio/wav', durationSeconds: seconds }
  }
}

// 注册：mock 无凭据、无网关；工厂按 deps 建实例（temp 产物放当前媒体目录）
registerAdapter('mock', (deps: AdapterDeps) => new MockProviderAdapter(deps), {
  supportedKinds: ['image', 'video', 'audio'],
  refCaps: { byKind: { image: { delivery: 'data_uri', maxBytes: 12 * 1024 * 1024 } } },
})
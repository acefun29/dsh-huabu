// mock 适配器（dsh-huabu 插件侧，上游 42db3cf 移除后按插件需要重写）：
// 无凭据、不联网，本地生成确定性 PNG——单测与零 Key 环境的端到端演示用。
// 行为契约：submit 立即受理；poll 前 2 次报 running 进度，第 3 次 succeeded 给本地产物。
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaProviderAdapter, ProviderPollResult, ProviderSubmitInput } from '../provider'
import type { AdapterDeps } from './registry'
import { registerAdapter } from './registry'
import { colorOfSeed, gradientPng } from '../png'
import type { MediaModelInfo } from '../shared'

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
]

interface MockJob {
  prompt: string
  width?: number
  height?: number
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
    if (!this.models.some((m) => m.id === model)) {
      throw new Error(`provider mock 下没有模型 ${model}（只有 ${this.models.map((m) => m.id).join(' / ')}）`)
    }
    const jobId = randomUUID()
    this.jobs.set(jobId, {
      prompt: input.prompt,
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
      polls: 0,
    })
    return Promise.resolve(jobId)
  }

  poll(_model: string, jobId: string): Promise<ProviderPollResult> {
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
    // 保持请求宽高比（比例参数经编排层换算成 width/height 传入）；边长只做上限钳制
    const aspect = job.width && job.height ? job.height / job.width : 9 / 16
    const width = Math.min(1024, Math.max(256, job.width ?? 1024))
    const height = Math.max(128, Math.round(width * aspect))
    // prompt 决定配色：两次不同 prompt 肉眼可区分；同 prompt 结果确定
    const png = gradientPng(width, height, colorOfSeed(job.prompt), colorOfSeed(`${job.prompt}#bottom`))
    const base = this.deps?.mediaDir() ?? tmpdir()
    const dir = join(base, '.mock-tmp')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${jobId}.png`)
    writeFileSync(file, png)
    return Promise.resolve({ status: 'succeeded', resultFile: file, fileExt: '.png', mime: 'image/png' })
  }
}

// 注册：mock 无凭据、无网关；工厂按 deps 建实例（temp 产物放当前媒体目录）
registerAdapter('mock', (deps: AdapterDeps) => new MockProviderAdapter(deps), {
  supportedKinds: ['image'],
  refCaps: { byKind: { image: { delivery: 'data_uri', maxBytes: 12 * 1024 * 1024 } } },
})
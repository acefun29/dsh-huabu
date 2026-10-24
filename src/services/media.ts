// huabu.media 服务（D1）：供应商目录合并、适配器实例化、任务提交/轮询/落盘/对账。
// 引擎与协议层整体移植自主仓库 src/main/media（见 src/media/，去 electron 化），
// 本文件只做插件侧接线：会话 cwd 绑定（huabu.project）、凭据来自环境变量/插件配置、
// mock 供应商常驻（零 Key 也能端到端）。
import { join } from 'node:path'
import '../media/adapters'
import type { AdapterProviderConfig } from '../media/adapters/registry'
import { createAdapters } from '../media/adapters/registry'
import { BUILTIN_PROVIDERS, mergeCatalog } from '../media/catalog'
import type { BuiltinProviderDef } from '../media/catalog/types'
import { MediaJobManager } from '../media/manager'
import type { MediaJobStatus } from '../media/shared'
import type { WorkspaceMediaConfig } from '../media/workspace-types'
import type { Project } from './project'
import { ProjectService } from './project'
import { resolveSessionCwd, type ToolExecLike, type WorkingDirectoryLike } from './session-cwd'

export const MEDIA_SERVICE_VERSION = '0.1.0'

// 供工具层与单测共用（同一 bundle = 同一适配器注册表实例；分开打包会拿到未注册的空表）
export { BUILTIN_PROVIDERS, mergeCatalog, PROVIDER_ID_PATTERN, MODEL_ID_PATTERN } from '../media/catalog'
export { createAdapters, getAdapterTypes, isRegisteredAdapterType } from '../media/adapters/registry'
export { MediaJobManager } from '../media/manager'

/** 插件常驻 mock 供应商（上游 42db3cf 移除；插件侧用于单测与零 Key 演示） */
const MOCK_PROVIDER_DEF: BuiltinProviderDef = {
  id: 'mock',
  label: 'Mock（本地零成本）',
  adapter: 'mock',
  auth: { env: 'HUABU_MOCK_KEY', label: '无需 API Key（本地生成）', helpUrl: '' },
  models: [
    {
      id: 'mock/poster',
      kind: 'image',
      label: 'Mock 海报',
      capabilities: { ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'], refQuota: [{ role: 'reference_image', max: 4 }] },
      costHint: '免费（本地像素，不联网）',
    },
    {
      id: 'mock/clip',
      kind: 'video',
      label: 'Mock 短片',
      capabilities: { ratios: ['16:9', '9:16'], durations: [4, 6, 8], refQuota: [{ role: 'first_frame', max: 1 }] },
      costHint: '免费（本地 ffmpeg，不联网）',
    },
    {
      id: 'mock/voice',
      kind: 'audio',
      label: 'Mock 音频',
      capabilities: { durations: [4, 8] },
      costHint: '免费（本地合成，不联网）',
    },
  ],
}

/** 媒体目录（相对工作区根的默认值与 App 一致：.huabu/media；可被 media.outputDir 覆盖） */
export const MEDIA_ROOT_REL = '.huabu/media'

export interface MediaProject {
  readonly project: Project
  readonly providers: AdapterProviderConfig[]
  readonly config: WorkspaceMediaConfig
  readonly manager: MediaJobManager
  /** 媒体产物目录（绝对路径，越界校验后的） */
  readonly mediaDir: string
  submit(request: Parameters<MediaJobManager['submit']>[0]): Promise<{ jobId: string }>
  waitForCompletion(jobId: string, opts?: Parameters<MediaJobManager['waitForCompletion']>[1]): Promise<MediaJobStatus>
  cancel(jobId: string): Promise<boolean>
  list(): MediaJobStatus[]
}

interface ManagerCacheEntry {
  mediaProject: MediaProject
  /** workspace.json 指纹：config 变化时重建适配器（与 App 的 mediaContext 缓存同语义） */
  configFingerprint: string
}

export interface MediaKeySources {
  /** 插件配置里的明文 Key（provider id → key）；只在内存，不落项目文件 */
  apiKeys?: Record<string, string>
}

export class MediaService {
  readonly version = MEDIA_SERVICE_VERSION
  private readonly cache = new Map<string, ManagerCacheEntry>()
  private readonly keySources: MediaKeySources

  constructor(
    private readonly projects: ProjectService = new ProjectService(),
    keySources: MediaKeySources = {},
  ) {
    this.keySources = keySources
  }

  /** 供应商凭据：插件配置明文 Key（按 authKey，合并层已缺省化为 provider id）优先，回退环境变量 */
  private readonly resolveKey = async (auth: {
    authKey?: string
    authEnv?: string
  }): Promise<string | undefined> => {
    if (auth.authKey && this.keySources.apiKeys?.[auth.authKey]) {
      return this.keySources.apiKeys[auth.authKey]
    }
    return auth.authEnv ? process.env[auth.authEnv] : undefined
  }

  /** 媒体产物目录：media.outputDir（默认 .huabu/media）解析到工作区内，写白名单校验 */
  static mediaDirOf(project: Project, config: WorkspaceMediaConfig): string {
    const rel = typeof config.outputDir === 'string' && config.outputDir.trim() ? config.outputDir : MEDIA_ROOT_REL
    return project.resolveWrite(rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''), { allowRoot: true })
  }

  forProject(project: Project): MediaProject {
    const config: WorkspaceMediaConfig = project.getMedia()
    const fingerprint = JSON.stringify(config)
    const cached = this.cache.get(project.root)
    if (cached && cached.configFingerprint === fingerprint) return cached.mediaProject

    const providers = mergeCatalog([...BUILTIN_PROVIDERS, MOCK_PROVIDER_DEF], {
      ...(Array.isArray(config.userProviders) ? { userProviders: config.userProviders } : {}),
      ...(Array.isArray(config.hiddenBuiltin) ? { hiddenBuiltin: config.hiddenBuiltin } : {}),
      ...(config.modelOverrides ? { modelOverrides: config.modelOverrides } : {}),
    })
    const mediaDir = MediaService.mediaDirOf(project, config)
    const adapters = createAdapters(providers, {
      mediaDir: () => mediaDir,
      resolveKey: async (auth) => this.resolveKey({ ...auth }),
    })
    const manager = new MediaJobManager(
      () => undefined,
      () => ({
        mediaDir,
        workspaceDir: project.root,
        config,
        providers,
        adapters,
        ready: true,
        notifyAssetsChanged: () => undefined,
        keySourceOf: async (auth) => {
          const key = await this.resolveKey({ ...auth })
          return key ? 'environment' : 'none'
        },
        resolveKey: async (auth) => this.resolveKey({ ...auth }),
      }),
    )
    // 首次构建该工作区时对账遗留任务（宿主重启后未完成任务标 interrupted——App 同语义）
    manager.reconcilePersistedJobs()

    const mediaProject: MediaProject = {
      project,
      providers,
      config,
      manager,
      mediaDir,
      submit: (request) => manager.submit(request),
      waitForCompletion: (jobId, opts) => manager.waitForCompletion(jobId, opts),
      cancel: (jobId) => manager.cancel(jobId),
      list: () => manager.list(),
    }
    this.cache.set(project.root, { mediaProject, configFingerprint: fingerprint })
    return mediaProject
  }

  /** 工具侧入口：先经 workingDirectory.ensure 取会话 cwd，再绑定句柄 */
  async forExec(
    ctx: { workingDirectory?: WorkingDirectoryLike },
    exec: ToolExecLike,
  ): Promise<MediaProject> {
    const cwd = await resolveSessionCwd(ctx, exec)
    return this.forProject(this.projects.open(cwd))
  }
}

/** jobs.json 路径（测试与对账断言用；账本总在媒体产物目录） */
export function jobsFileOf(mediaDir: string): string {
  return join(mediaDir, 'jobs.json')
}
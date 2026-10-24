// D2 huabu_image_generate 工具：参数校验 → provider/model 解析（mediaResolve 回退链）
// → MediaJobManager.submit + waitForCompletion（同步等待）→ 文本（实际参数+路径）
// + PNG 经 attachments 回喂。失败抛可操作错误（DSH 把它作为普通错误结果返回）。
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { MediaProject } from '../services/media'
import type { MediaService } from '../services/media'
import { Assets, assetDirForKind } from '../services/assets'
import type { ToolExecLike, WorkingDirectoryLike } from '../services/session-cwd'
import { MEDIA_RATIOS, type MediaJobStatus, type MediaRatio, type MediaRefInput } from '../media/shared'
import { resolveMediaTarget } from '../media/mediaResolve'

export const IMAGE_TOOL_NAME = 'huabu_image_generate'

/** 插件默认供应商：未配置 agentProvider 时用 mock（零 Key 可用；真实网关配 Key 后接管） */
export const DEFAULT_AGENT_PROVIDER = 'mock'

export interface ImageToolContext {
  workingDirectory?: WorkingDirectoryLike
  attachments?: { saveImage(input: { data: Buffer; mediaType: string; name?: string }): Promise<unknown> }
}

export interface ImageToolExecLike {
  cwd?: string
  agent?: unknown
  signal?: AbortSignal
  /** DSH 工具调用的 call/rootCall id（jobs 的 toolCall 关联用；宿主提供时有值） */
  callId?: string
  rootCallId?: string
}

export interface ImageAttachmentRef {
  attachmentId: string
  mediaType?: string
  name?: string
  width?: number
  height?: number
  bytes?: number
}

export interface ImageToolValue {
  tool: string
  ok: boolean
  jobId: string
  provider: string
  model: string
  text: string
  artifactRelPath?: string
  images?: ImageAttachmentRef[]
}

const PARAMETERS = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: '画面描述（越具体越好：主体、风格、构图、光线）' },
    name: { type: 'string', description: '产物文件主名（不含扩展名；缺省用 jobId）' },
    ratio: { type: 'string', enum: [...MEDIA_RATIOS], description: '画面比例（1:1/3:4/4:3/9:16/16:9/21:9；模型不支持时会被拒）' },
    reference_images: {
      type: 'array',
      items: { type: 'string' },
      description: '垫图的工作区相对路径（以参考图为底生成；条数上限由模型决定）',
    },
  },
  required: ['prompt'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    ok: { type: 'boolean' },
    jobId: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    text: { type: 'string' },
    artifactRelPath: { type: 'string' },
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          name: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          bytes: { type: 'number' },
        },
        required: ['attachmentId'],
      },
    },
  },
  required: ['tool', 'ok', 'jobId', 'provider', 'model', 'text'],
}

export function parseImageArgs(raw: Record<string, unknown>): {
  prompt: string
  name?: string
  ratio?: MediaRatio
  referenceImages: string[]
} {
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  if (!prompt) throw new Error('缺少 prompt 参数（画面描述）')
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined
  const ratio = raw.ratio === undefined || raw.ratio === null ? undefined : raw.ratio
  if (ratio !== undefined && (typeof ratio !== 'string' || !(MEDIA_RATIOS as readonly string[]).includes(ratio))) {
    throw new Error(`未知 ratio：「${String(ratio)}」；可用：${MEDIA_RATIOS.join(' / ')}`)
  }
  let referenceImages: string[] = []
  if (raw.reference_images !== undefined && raw.reference_images !== null) {
    if (!Array.isArray(raw.reference_images)) throw new Error('reference_images 必须是字符串数组（工作区相对路径）')
    referenceImages = raw.reference_images.map((item) => {
      if (typeof item !== 'string' || !item.trim()) throw new Error('reference_images 的每一项必须是工作区相对路径')
      return item.trim()
    })
  }
  return { prompt, ...(name ? { name } : {}), ...(ratio ? { ratio: ratio as MediaRatio } : {}), referenceImages }
}

/**
 * 生成产物落库目录（与 App resolveOutputLibrary 同语义，收紧到插件写白名单）：
 * 类型默认库/全局默认库 → 命名库（仅 assets/ 内）；'builtin-assets'/缺省 → assets/images；
 * 'none' → 不落库（留在 .huabu/media）。
 */
export function resolveOutputDir(
  media: MediaProject,
  kind: 'image' | 'video' | 'audio',
): string | undefined {
  const config = media.config
  const wanted = config.kindLibraryDefaults?.[kind] ?? config.defaultLibraryId
  if (wanted === 'none') return undefined
  if (wanted === 'builtin-assets' || !wanted) return assetDirForKind(kind)
  const libraries = new Assets(media.project).libraries()
  const hit = libraries.find((l) => l.id === wanted || l.name === wanted)
  const insideAssets = (path: string): boolean => {
    try {
      return media.project.resolve(path).startsWith(media.project.resolve('assets'))
    } catch {
      return false
    }
  }
  if (hit && insideAssets(hit.path)) return hit.path
  const publicLib = libraries.find((l) => l.isPublic === true)
  if (publicLib && insideAssets(publicLib.path)) return publicLib.path
  return assetDirForKind(kind)
}

/** provider/model 解析（mediaResolve 回退链；插件默认供应商 = mock） */
export function resolveAgentMedia(
  media: MediaProject,
  kind: 'image' | 'video' | 'audio',
): { provider: string; model: string } {
  const resolved = resolveMediaTarget(media.providers, {
    kind,
    agentProvider: media.config.agentProvider ?? DEFAULT_AGENT_PROVIDER,
    agentModels: media.config.agentModels,
  })
  if (!resolved) {
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'
    throw new Error(
      `没有可用的${label}生成模型：请在 workspace.json 的 media 段配置 agentProvider/agentModels，` +
        '或为所选供应商（dashscope/volcark/openai/minimax/tencent）设置环境变量 Key（如 DASHSCOPE_KEY）',
    )
  }
  return { provider: resolved.provider, model: resolved.model }
}

function plainAttachmentRef(raw: unknown): ImageAttachmentRef | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.attachmentId !== 'string' || !rec.attachmentId) return null
  const ref: ImageAttachmentRef = { attachmentId: rec.attachmentId }
  if (typeof rec.mediaType === 'string') ref.mediaType = rec.mediaType
  if (typeof rec.name === 'string') ref.name = rec.name
  if (typeof rec.width === 'number') ref.width = rec.width
  if (typeof rec.height === 'number') ref.height = rec.height
  if (typeof rec.bytes === 'number') ref.bytes = rec.bytes
  return ref
}

function resultText(final: MediaJobStatus, artifactDirRel: string): string {
  const artifact = final.artifact
  const where = artifact ? `${artifactDirRel}/${artifact.relPath}` : '(无产物)'
  const dims =
    artifact?.width && artifact?.height ? `，实际 ${artifact.width}×${artifact.height}px` : ''
  const ratio = final.params?.ratio ? `比例 ${final.params.ratio}` : ''
  return (
    `[huabu_image_generate · ${final.provider}/${final.model}]\n` +
    `生成完成：${where}${dims}${ratio ? `（${ratio}）` : ''}，大小 ${artifact ? Math.max(1, Math.round(artifact.bytes / 1024)) : '?'}KB。\n` +
    '产物已同时归档进素材库（huabu_asset_list 可查）；如需改动请基于这张图重新生成或换参考图。'
  )
}

export function assembleImageTool(ctx: ImageToolContext, service: Pick<MediaService, 'forExec'>) {
  return {
    name: IMAGE_TOOL_NAME,
    description:
      '根据文字描述生成一张图片（可用 reference_images 垫图）。同步等待生成完成（约数十秒），' +
      '成功返回实际参数、产物路径与图片本身。默认用零成本的 mock 供应商（本地占位图，验证流程用）；' +
      '真实出图需在环境变量配好对应供应商的 Key（DASHSCOPE_KEY / ARK_KEY / MINIMAX_KEY / TENCENT_KEY / OPENAI_KEY）' +
      '并在 workspace.json media 段把 agentProvider 指过去。产物落 assets/images/ 素材库。',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: Record<string, unknown>, value: ImageToolValue) {
        const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: value.text }]
        for (const image of value.images ?? []) blocks.push({ type: 'image', attachment: image })
        return blocks
      },
    },
    timeoutMs: 300_000,
    async execute(rawArgs: Record<string, unknown>, exec: ImageToolExecLike): Promise<ImageToolValue> {
      const input = parseImageArgs(rawArgs)
      const media = await service.forExec(ctx, exec)
      const resolution = resolveAgentMedia(media, 'image')

      const refs: MediaRefInput[] = input.referenceImages.map((path) => ({ role: 'reference_image', path }))
      for (const ref of refs) {
        if (!existsSync(media.project.resolve(ref.path!))) {
          throw new Error(`参考图不存在：${ref.path}（必须是工作区相对路径；先落盘或用 huabu_asset_list 查可用素材）`)
        }
      }

      const outputDir = resolveOutputDir(media, 'image')
      const { jobId } = await media.submit({
        kind: 'image',
        provider: resolution.provider,
        model: resolution.model,
        prompt: input.prompt,
        ...(input.name ? { name: input.name } : {}),
        ...(input.ratio ? { ratio: input.ratio } : {}),
        ...(refs.length > 0 ? { refs } : {}),
        ...(outputDir ? { outputDir } : {}),
      })

      const final = await media.waitForCompletion(jobId, {
        ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      })

      if (final.state === 'cancelled') {
        return JSON.parse(
          JSON.stringify({
            tool: IMAGE_TOOL_NAME,
            ok: false,
            jobId,
            provider: resolution.provider,
            model: resolution.model,
            text: `[huabu_image_generate] 已取消（用户中断）；如需继续请重新发起。`,
          }),
        ) as ImageToolValue
      }
      if (final.state !== 'succeeded' || !final.artifact) {
        throw new Error(
          `[huabu_image_generate · ${resolution.provider}/${resolution.model}] 生成失败：${final.error ?? final.message ?? '未知错误'}。` +
            '请把失败原因转告用户；临时性错误可重试一次，凭据类错误需先配 Key。',
        )
      }

      const artifactDirRel = final.artifactDirRel ?? '.huabu/media'
      let text = resultText(final, artifactDirRel)
      const images: ImageAttachmentRef[] = []

      // 产物目录以任务状态里的 artifactDirRel 为准（落库目录优先于默认产物目录）
      let artifactAbs = ''
      try {
        artifactAbs = join(media.project.resolve(artifactDirRel), final.artifact.relPath)
      } catch {
        artifactAbs = join(media.mediaDir, final.artifact.relPath)
      }
      if (existsSync(artifactAbs)) {
        try {
          const bytes = await readFile(artifactAbs)
          const isPng = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
          const save = ctx.attachments?.saveImage
          if (!isPng) {
            text += `\n（图片未回喂：产物不是 PNG；文件在 ${artifactDirRel}/${final.artifact.relPath}）`
          } else if (typeof save !== 'function') {
            text += `\n（图片未回喂：附件服务不可用；文件在 ${artifactDirRel}/${final.artifact.relPath}）`
          } else {
            const ref = plainAttachmentRef(
              await save.call(ctx.attachments, {
                data: bytes,
                mediaType: 'image/png',
                name: basename(artifactAbs),
              }),
            )
            if (ref) {
              images.push(ref)
              text += '\n图片已随本条结果附上。'
            } else {
              text += `\n（图片未回喂：saveImage 返回值缺少 attachmentId）`
            }
          }
        } catch (error) {
          text += `\n（图片回喂失败：${error instanceof Error ? error.message : String(error)}；文件在 ${artifactDirRel}/${final.artifact.relPath}）`
        }
      }

      const value: ImageToolValue = {
        tool: IMAGE_TOOL_NAME,
        ok: true,
        jobId,
        provider: final.provider,
        model: final.model,
        text,
        artifactRelPath: `${artifactDirRel}/${final.artifact.relPath}`,
        ...(images.length > 0 ? { images } : {}),
      }
      return JSON.parse(JSON.stringify(value)) as ImageToolValue
    },
  }
}
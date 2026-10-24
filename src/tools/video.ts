// E1/E2/E5：huabu_video_generate / huabu_audio_generate。
// 视频：对话式确认闸门（confirmed）→ ctx.jobs 后台运行（不阻塞会话，完成自动唤醒）；
// 音频：同走 job。配额：maxJobsPerHour / maxVideoSeconds（config 可覆盖）。
// jobs 服务缺失时退化为同步等待（受工具 timeout 约束），并在文本里说明。
import { existsSync } from 'node:fs'
import type { MediaProject, MediaService } from '../services/media'
import { MEDIA_RATIOS, type MediaRatio, type MediaRefInput, type MediaRefRole } from '../media/shared'
import { resolveAgentMedia, resolveOutputDir } from './image'
import type { ImageToolContext, ImageToolExecLike } from './image'

export const VIDEO_TOOL_NAME = 'huabu_video_generate'
export const AUDIO_TOOL_NAME = 'huabu_audio_generate'

export const DEFAULT_MAX_JOBS_PER_HOUR = 10
export const DEFAULT_MAX_VIDEO_SECONDS = 60

/** ctx.jobs 的窄化视图（宿主 dsh-jobs-local；经 ctx.get('jobs') 动态取，不进 inject） */
export interface JobsServiceLike {
  start(spec: {
    kind: string
    label: string
    owner: string
    toolCall?: { callId?: string; rootCallId?: string }
    outputLimitBytes?: number
    output?: Array<{ read: (fromByte: number) => { text: string; nextOffset: number; lossy: boolean } }>
    run: () => { cancel: () => void; done: Promise<{ status: 'completed' | 'failed' | 'killed'; detail: string }> }
  }): string
}

export interface MediaJobToolContext extends ImageToolContext {
  get?(name: 'jobs'): JobsServiceLike | undefined
}

export interface VideoToolValue {
  tool: string
  ok: boolean
  needsConfirm?: boolean
  jobId?: string
  provider?: string
  model?: string
  text: string
  artifactRelPath?: string
}

interface ParsedMediaJobArgs {
  prompt: string
  name?: string
  ratio?: MediaRatio
  durationSeconds?: number
  voice?: string
  refs: MediaRefInput[]
  confirmed: boolean
}

function textParam(raw: Record<string, unknown>, field: string): string | undefined {
  if (raw[field] === undefined || raw[field] === null) return undefined
  if (typeof raw[field] !== 'string') throw new Error(`${field} 必须是字符串`)
  const trimmed = (raw[field] as string).trim()
  return trimmed || undefined
}

function intParam(raw: Record<string, unknown>, field: string, min: number, max: number): number | undefined {
  if (raw[field] === undefined || raw[field] === null) return undefined
  if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field])) throw new Error(`${field} 必须是数字`)
  const value = Math.round(raw[field])
  if (value < min || value > max) throw new Error(`${field} 必须在 ${min}–${max} 之间`)
  return value
}

function refSlot(raw: Record<string, unknown>, param: string, role: MediaRefRole): MediaRefInput[] {
  const value = raw[param]
  if (value === undefined || value === null) return []
  const single = typeof value === 'string' ? [value] : value
  if (!Array.isArray(single) || single.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${param} 必须是工作区相对路径（字符串）`)
  }
  return (single as string[]).map((path) => ({ role, path: path.trim() }))
}

export function parseVideoArgs(raw: Record<string, unknown>): ParsedMediaJobArgs {
  const prompt = textParam(raw, 'prompt')
  if (!prompt) throw new Error('缺少 prompt 参数（内容描述）')
  const ratio = textParam(raw, 'ratio')
  if (ratio && !(MEDIA_RATIOS as readonly string[]).includes(ratio)) {
    throw new Error(`未知 ratio：「${ratio}」；可用：${MEDIA_RATIOS.join(' / ')}`)
  }
  const refs = [
    ...refSlot(raw, 'first_frame', 'first_frame'),
    ...refSlot(raw, 'last_frame', 'last_frame'),
    ...refSlot(raw, 'reference_images', 'reference_image'),
    ...refSlot(raw, 'reference_videos', 'reference_video'),
    ...refSlot(raw, 'reference_audios', 'reference_audio'),
  ]
  if (
    refs.some((ref) => ref.role === 'first_frame' || ref.role === 'last_frame') &&
    refs.some((ref) => ref.role.startsWith('reference_'))
  ) {
    throw new Error('first_frame/last_frame 与 reference_* 不能混用（模型按角色二选一），请拆成两次生成')
  }
  return {
    prompt,
    ...(textParam(raw, 'name') ? { name: textParam(raw, 'name') } : {}),
    ...(ratio ? { ratio: ratio as MediaRatio } : {}),
    durationSeconds: intParam(raw, 'duration_seconds', 2, 60),
    ...(textParam(raw, 'voice') ? { voice: textParam(raw, 'voice') } : {}),
    refs,
    confirmed: raw.confirmed === true,
  }
}

export function parseAudioArgs(raw: Record<string, unknown>): ParsedMediaJobArgs {
  const prompt = textParam(raw, 'prompt')
  if (!prompt) throw new Error('缺少 prompt 参数（音频内容描述）')
  return {
    prompt,
    ...(textParam(raw, 'name') ? { name: textParam(raw, 'name') } : {}),
    durationSeconds: intParam(raw, 'duration_seconds', 2, 60),
    ...(textParam(raw, 'voice') ? { voice: textParam(raw, 'voice') } : {}),
    refs: [],
    confirmed: true,
  }
}

/** 近一小时该 kind 的提交数（含未落账的内存态 + 账本历史） */
export function recentSubmissions(media: MediaProject, kind: 'video' | 'audio', now = Date.now()): number {
  const hourAgo = now - 3_600_000
  return media
    .list()
    .filter((job) => job.kind === kind && Date.parse(job.createdAt) >= hourAgo)
    .length
}

function confirmNeeded(media: MediaProject): boolean {
  return media.config.confirmVideo !== false
}

function paramLine(input: ParsedMediaJobArgs): string {
  const parts = [`prompt「${input.prompt.slice(0, 60)}」`]
  if (input.ratio) parts.push(`比例 ${input.ratio}`)
  if (input.durationSeconds) parts.push(`时长 ${input.durationSeconds}s`)
  if (input.refs.length > 0) parts.push(`参考素材 ${input.refs.length} 项`)
  if (input.name) parts.push(`命名 ${input.name}`)
  return parts.join(' · ')
}

/** 进度日志环：jobs 的 output pull source 读它；偏移按 UTF-8 字节计（与宿主 ring 一致） */
class ProgressLog {
  private buf = Buffer.alloc(0)
  append(line: string): void {
    this.buf = Buffer.concat([this.buf, Buffer.from(`${line}\n`, 'utf8')])
  }
  read = (fromByte: number): { text: string; nextOffset: number; lossy: boolean } => {
    const start = Math.max(0, Math.min(fromByte, this.buf.length))
    return {
      text: this.buf.subarray(start).toString('utf8'),
      nextOffset: this.buf.length,
      lossy: fromByte < start,
    }
  }
}

async function runMediaJob(
  ctx: MediaJobToolContext,
  service: Pick<MediaService, 'forExec'>,
  exec: ImageToolExecLike,
  kind: 'video' | 'audio',
  input: ParsedMediaJobArgs,
  toolName: string,
): Promise<VideoToolValue> {
  const media = await service.forExec(ctx, exec)
  const resolution = resolveAgentMedia(media, kind)

  // 配额（E2）：maxJobsPerHour / maxVideoSeconds
  const maxJobs = DEFAULT_MAX_JOBS_PER_HOUR
  const maxSeconds = DEFAULT_MAX_VIDEO_SECONDS
  if (input.durationSeconds !== undefined && input.durationSeconds > maxSeconds) {
    throw new Error(`时长超过上限（${input.durationSeconds}s > ${maxSeconds}s）：请分段生成或降低时长`)
  }
  if (recentSubmissions(media, kind) >= maxJobs) {
    throw new Error(`近 1 小时的${kind === 'video' ? '视频' : '音频'}生成已达上限（${maxJobs} 个）：请稍后再试或清理任务账本`)
  }

  for (const ref of input.refs) {
    if (ref.path && !existsSync(media.project.resolve(ref.path))) {
      throw new Error(`参考素材不存在：${ref.path}（必须是工作区相对路径）`)
    }
  }

  const outputDir = resolveOutputDir(media, kind)
  const jobs = ctx.get?.('jobs')

  const submitOnce = async () => {
    const { jobId } = await media.submit({
      kind,
      provider: resolution.provider,
      model: resolution.model,
      prompt: input.prompt,
      ...(input.name ? { name: input.name } : {}),
      ...(input.ratio ? { ratio: input.ratio } : {}),
      ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.refs.length > 0 ? { refs: input.refs } : {}),
      ...(outputDir ? { outputDir } : {}),
    })
    return jobId
  }

  // 后台 job（正常路径）：立即返回 jobId，完成后宿主唤醒模型读 job_output
  if (jobs) {
    const log = new ProgressLog()
    let mediaJobId = ''
    const owner = (exec.agent as { id?: string } | undefined)?.id
    if (!owner) throw new Error('当前工具调用没有 agent 会话，无法启动后台任务')
    const jobId = jobs.start({
      kind: `huabu-${kind}`,
      label: `${toolName} ${input.name ?? input.prompt.slice(0, 40)}`,
      ...(exec.callId !== undefined || exec.rootCallId !== undefined
        ? {
            toolCall: {
              ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
              ...(exec.rootCallId !== undefined ? { rootCallId: exec.rootCallId } : {}),
            },
          }
        : {}),
      owner,
      outputLimitBytes: 16 * 1024,
      output: [{ read: (fromByte) => log.read(fromByte) }],
      run: () => {
        log.append(`[${toolName}] 提交到 ${resolution.provider}/${resolution.model}（${paramLine(input)}）`)
        let mediaJobId = ''
        const done = (async () => {
          try {
            mediaJobId = await submitOnce()
            log.append(`已受理（媒体任务 ${mediaJobId.slice(0, 8)}…），开始生成`)
          } catch (error) {
            return { status: 'failed' as const, detail: `提交失败：${error instanceof Error ? error.message : String(error)}` }
          }
          const final = await media.waitForCompletion(mediaJobId, {
            onProgress: (job) => log.append(`${job.message ?? '进行中'}${job.progress !== undefined ? `（${Math.round(job.progress * 100)}%）` : ''}`),
          })
          if (final.state === 'succeeded' && final.artifact) {
            const where = `${final.artifactDirRel ?? '.huabu/media'}/${final.artifact.relPath}`
            log.append(`完成：${where}${final.artifact.durationSeconds ? `（${final.artifact.durationSeconds}s）` : ''}`)
            return {
              status: 'completed' as const,
              detail: `[huabu] ${kind === 'video' ? '视频' : '音频'}生成完成：${where}（${Math.max(1, Math.round((final.artifact?.bytes ?? 0) / 1024))}KB）。产物已归档进素材库，可交给用户或继续加工。`,
            }
          }
          if (final.state === 'cancelled') return { status: 'killed' as const, detail: '[huabu] 任务已取消' }
          return { status: 'failed' as const, detail: `[huabu] 生成失败：${final.error ?? final.message ?? '未知错误'}` }
        })()
        return {
          cancel: () => {
            if (mediaJobId) void media.cancel(mediaJobId)
            log.append('收到取消请求…')
          },
          done,
        }
      },
    })
    return {
      tool: toolName,
      ok: true,
      jobId,
      provider: resolution.provider,
      model: resolution.model,
      text:
        `[${toolName} · ${resolution.provider}/${resolution.model}] 已提交后台任务（job ${jobId}），会话不被阻塞。` +
        '任务完成会自动通知，届时用 job_output 读取结果；期间可用 job_list 查看状态、job_kill 取消。',
    }
  }

  // jobs 不可用 → 同步退化（受工具 timeoutMs 约束）
  const mediaJobId = await submitOnce()
  const final = await media.waitForCompletion(mediaJobId, {
    ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
  })
  if (final.state === 'succeeded' && final.artifact) {
    const where = `${final.artifactDirRel ?? '.huabu/media'}/${final.artifact.relPath}`
    return {
      tool: toolName,
      ok: true,
      jobId: mediaJobId,
      provider: resolution.provider,
      model: resolution.model,
      text: `[${toolName} · ${resolution.provider}/${resolution.model}]（同步模式：宿主无 jobs 服务）\n完成：${where}`,
      artifactRelPath: where,
    }
  }
  throw new Error(
    `[${toolName}] 生成失败：${final.error ?? final.message ?? '未知错误'}（同步模式：宿主无 jobs 服务）`,
  )
}

export function assembleVideoTool(ctx: MediaJobToolContext, service: Pick<MediaService, 'forExec'>) {
  return {
    name: VIDEO_TOOL_NAME,
    description:
      '生成一段短视频（后台任务，不阻塞会话）。成本高：**必须先向用户确认，用户同意后带 confirmed=true 调用**，否则只返回待确认参数、不提交。' +
      '参考素材按角色分槽：first_frame/last_frame（首尾帧）与 reference_*（全模态参考）不能混用。' +
      '默认 mock 供应商（本地 ffmpeg 测试图，验证流程用）；真实出片需配 Key 并把 media.agentProvider 指过去。产物落 assets/video/。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '内容描述（主体、动作、镜头运动、氛围）' },
        name: { type: 'string', description: '产物文件主名' },
        ratio: { type: 'string', enum: [...MEDIA_RATIOS], description: '画面比例' },
        duration_seconds: { type: 'number', description: '时长秒（模型档位内就近归档；上限 60s）' },
        first_frame: { type: 'string', description: '首帧图的工作区相对路径' },
        last_frame: { type: 'string', description: '尾帧图的工作区相对路径' },
        reference_images: { type: 'array', items: { type: 'string' }, description: '参考图（工作区相对路径）' },
        reference_videos: { type: 'array', items: { type: 'string' }, description: '参考视频' },
        reference_audios: { type: 'array', items: { type: 'string' }, description: '参考音频' },
        confirmed: { type: 'boolean', description: '用户已同意本次生成（含成本提示）后置 true' },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          ok: { type: 'boolean' },
          needsConfirm: { type: 'boolean' },
          jobId: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          text: { type: 'string' },
          artifactRelPath: { type: 'string' },
        },
        required: ['tool', 'ok', 'text'],
      },
      render(_args: Record<string, unknown>, value: VideoToolValue) {
        return [{ type: 'text', text: value.text }]
      },
    },
    timeoutMs: 60_000,
    async execute(rawArgs: Record<string, unknown>, exec: ImageToolExecLike): Promise<VideoToolValue> {
      const input = parseVideoArgs(rawArgs)
      const media = await service.forExec(ctx, exec)
      if (!input.confirmed && confirmNeeded(media)) {
        return {
          tool: VIDEO_TOOL_NAME,
          ok: true,
          needsConfirm: true,
          text:
            `[huabu_video_generate] 需要用户确认后才提交（视频生成成本高）。\n拟提交参数：${paramLine(input)}。\n` +
            '请把参数与成本提示告诉用户；用户明确同意后，带 confirmed=true 重新调用（参数保持不变）。在用户同意前不要提交。',
        }
      }
      const value = await runMediaJob(ctx, service, exec, 'video', input, VIDEO_TOOL_NAME)
      return JSON.parse(JSON.stringify(value)) as VideoToolValue
    },
  }
}

export function assembleAudioTool(ctx: MediaJobToolContext, service: Pick<MediaService, 'forExec'>) {
  return {
    name: AUDIO_TOOL_NAME,
    description:
      '生成一段音频（音效/配乐，后台任务不阻塞会话）。可选 voice 音色、duration_seconds 时长。' +
      '默认 mock 供应商（本地合成正弦扫频，验证流程用）；真实生成需配 Key。产物落 assets/audio/。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '音频内容描述（乐器/风格/情绪/节奏）' },
        name: { type: 'string', description: '产物文件主名' },
        duration_seconds: { type: 'number', description: '时长秒（2–60）' },
        voice: { type: 'string', description: '音色 id（模型声明 voices 清单时生效）' },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          ok: { type: 'boolean' },
          jobId: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['tool', 'ok', 'text'],
      },
      render(_args: Record<string, unknown>, value: VideoToolValue) {
        return [{ type: 'text', text: value.text }]
      },
    },
    timeoutMs: 60_000,
    async execute(rawArgs: Record<string, unknown>, exec: ImageToolExecLike): Promise<VideoToolValue> {
      const input = parseAudioArgs(rawArgs)
      const value = await runMediaJob(ctx, service, exec, 'audio', input, AUDIO_TOOL_NAME)
      return JSON.parse(JSON.stringify(value)) as VideoToolValue
    },
  }
}
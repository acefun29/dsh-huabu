// F2/F3：huabu_video_skim（粗扫 6 帧 + 元数据 + 时间轴）/ huabu_video_frames（区间精读 ≤8 帧 + 缓存）。
// 帧经 attachments 回喂（模型可见；人看图走 v0.1.x 可选的帧带卡——按评审决定本期不注册）。
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import type { VisionService } from '../services/vision'
import { VIDEO_FRAME_MAX_EDGE, VFRAMES_DIR_REL, evenTimeline } from '../services/vision'
import type { ImageAttachmentRef, ImageToolContext, ImageToolExecLike } from './image'

export const SKIM_TOOL_NAME = 'huabu_video_skim'
export const FRAMES_TOOL_NAME = 'huabu_video_frames'

export const SKIM_FRAME_COUNT = 6
export const MAX_DETAIL_FRAMES = 8
export const MAX_SPAN_SECONDS = 300

const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.mkv', '.avi']

export interface VisionToolValue {
  tool: string
  ok: boolean
  text: string
  videoPath: string
  images: ImageAttachmentRef[]
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

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(1)
  return m > 0 ? `${m}m${s}s` : `${s}s`
}

export function assembleVisionTools(ctx: ImageToolContext, vision: Pick<VisionService, 'ffmpeg' | 'probe' | 'frames'>, workspaceOf: (exec: ImageToolExecLike) => Promise<{ resolve: (rel: string) => string; ensureDir: (rel: string) => string }>) {
  const attachFrames = async (
    images: ImageAttachmentRef[],
    frames: Array<{ time: number; png: Buffer }>,
    videoName: string,
    textRef: { text: string },
  ): Promise<void> => {
    const save = ctx.attachments?.saveImage
    if (typeof save !== 'function') {
      textRef.text += '\n（帧未回喂：附件服务不可用）'
      return
    }
    for (const frame of frames) {
      try {
        const ref = plainAttachmentRef(
          await save.call(ctx.attachments, {
            data: frame.png,
            mediaType: 'image/png',
            name: `${videoName}@${frame.time.toFixed(1)}s.png`,
          }),
        )
        if (ref) images.push(ref)
      } catch (error) {
        textRef.text += `\n（帧 ${frame.time.toFixed(1)}s 回喂失败：${error instanceof Error ? error.message : String(error)}）`
      }
    }
  }

  const resolveVideo = async (exec: ImageToolExecLike, rawPath: unknown): Promise<{ abs: string; rel: string }> => {
    if (typeof rawPath !== 'string' || !rawPath.trim()) throw new Error('缺少 path 参数（视频的工作区相对路径）')
    const rel = rawPath.trim()
    const workspace = await workspaceOf(exec)
    const abs = workspace.resolve(rel)
    if (!existsSync(abs)) throw new Error(`视频不存在：${rel}（用 huabu_asset_list kind=video 查可用素材）`)
    if (!VIDEO_EXTS.includes(extname(abs).toLowerCase())) {
      throw new Error(`不是视频文件（支持 ${VIDEO_EXTS.join(' / ')}）：${rel}`)
    }
    return { abs, rel }
  }

  const skim = {
    name: SKIM_TOOL_NAME,
    description:
      '视频粗扫理解：抽 6 帧均匀时间轴 + 时长/分辨率/帧率元数据，帧图随结果回喂（你直接看图即可，不需要读文件）。' +
      '回答「这段视频里是什么画面」先调它；要精读某个区间用 huabu_video_frames。需要 ffmpeg。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '视频的工作区相对路径' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          ok: { type: 'boolean' },
          text: { type: 'string' },
          videoPath: { type: 'string' },
          images: { type: 'array', items: { type: 'object', properties: { attachmentId: { type: 'string' } }, required: ['attachmentId'] } },
        },
        required: ['tool', 'ok', 'text', 'videoPath'],
      },
      render(_args: Record<string, unknown>, value: VisionToolValue) {
        const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: value.text }]
        for (const image of value.images) blocks.push({ type: 'image', attachment: image })
        return blocks
      },
    },
    timeoutMs: 120_000,
    async execute(rawArgs: Record<string, unknown>, exec: ImageToolExecLike): Promise<VisionToolValue> {
      const { abs, rel } = await resolveVideo(exec, rawArgs.path)
      const meta = vision.probe(abs)
      if (meta.durationSeconds <= 0) throw new Error(`无法解析视频时长（文件可能损坏）：${rel}`)
      const workspace = await workspaceOf(exec)
      const frames = vision.frames({
        videoPath: abs,
        times: evenTimeline(meta.durationSeconds, SKIM_FRAME_COUNT),
        maxEdge: VIDEO_FRAME_MAX_EDGE,
        cacheDir: workspace.ensureDir(VFRAMES_DIR_REL),
      })
      const images: ImageAttachmentRef[] = []
      const textRef = {
        text:
          `[${SKIM_TOOL_NAME}] ${rel}\n` +
          `时长 ${meta.durationSeconds.toFixed(1)}s${meta.width && meta.height ? ` · ${meta.width}×${meta.height}px` : ''}${meta.fps ? ` · ${meta.fps}fps` : ''}\n` +
          `时间轴（${frames.length}/${SKIM_FRAME_COUNT} 帧，已按时间顺序附上）：` +
          frames.map((f) => formatTime(f.time)).join('、'),
      }
      await attachFrames(images, frames, rel.split('/').pop() ?? 'video', textRef)
      if (frames.length > 0) textRef.text += '\n请按时间顺序查看附图回答画面内容；细节看不清的区间用 huabu_video_frames 精读。'
      const value: VisionToolValue = { tool: SKIM_TOOL_NAME, ok: frames.length > 0, text: textRef.text, videoPath: rel, images }
      return JSON.parse(JSON.stringify(value)) as VisionToolValue
    },
  }

  const framesTool = {
    name: FRAMES_TOOL_NAME,
    description:
      '视频区间精读：在 [start_seconds, end_seconds] 内均匀抽 ≤8 帧回喂（缓存 .huabu/vframes，重复读不重复抽）。' +
      '区间上限 300s；超出请分段。先 huabu_video_skim 粗扫定位，再对看不清的区间用本工具。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '视频的工作区相对路径' },
        start_seconds: { type: 'number', description: '区间起点（秒，≥0）' },
        end_seconds: { type: 'number', description: '区间终点（秒；区间 ≤300s）' },
        count: { type: 'number', description: `抽帧数（1–${MAX_DETAIL_FRAMES}，默认 6）` },
      },
      required: ['path', 'start_seconds', 'end_seconds'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          ok: { type: 'boolean' },
          text: { type: 'string' },
          videoPath: { type: 'string' },
          images: { type: 'array', items: { type: 'object', properties: { attachmentId: { type: 'string' } }, required: ['attachmentId'] } },
        },
        required: ['tool', 'ok', 'text', 'videoPath'],
      },
      render(_args: Record<string, unknown>, value: VisionToolValue) {
        const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: value.text }]
        for (const image of value.images) blocks.push({ type: 'image', attachment: image })
        return blocks
      },
    },
    timeoutMs: 120_000,
    async execute(rawArgs: Record<string, unknown>, exec: ImageToolExecLike): Promise<VisionToolValue> {
      const { abs, rel } = await resolveVideo(exec, rawArgs.path)
      for (const field of ['start_seconds', 'end_seconds']) {
        if (typeof rawArgs[field] !== 'number' || !Number.isFinite(rawArgs[field] as number)) {
          throw new Error(`${field} 必须是数字（秒）`)
        }
      }
      const start = Math.max(0, rawArgs.start_seconds as number)
      const end = rawArgs.end_seconds as number
      if (end <= start) throw new Error(`end_seconds 必须大于 start_seconds（当前 ${start}–${end}）`)
      if (end - start > MAX_SPAN_SECONDS) {
        throw new Error(`区间超上限（${Math.round(end - start)}s > ${MAX_SPAN_SECONDS}s）：请分段精读`)
      }
      const count = rawArgs.count === undefined || rawArgs.count === null ? 6 : rawArgs.count
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_DETAIL_FRAMES) {
        throw new Error(`count 必须是 1–${MAX_DETAIL_FRAMES} 的整数`)
      }
      const workspace = await workspaceOf(exec)
      const span = end - start
      const times = Array.from({ length: count }, (_, i) => Number((start + (span * i) / Math.max(1, count - 1)).toFixed(2)))
      const frames = vision.frames({
        videoPath: abs,
        times,
        maxEdge: VIDEO_FRAME_MAX_EDGE,
        cacheDir: workspace.ensureDir(VFRAMES_DIR_REL),
      })
      const images: ImageAttachmentRef[] = []
      const textRef = {
        text:
          `[${FRAMES_TOOL_NAME}] ${rel} 区间 ${formatTime(start)}–${formatTime(end)}\n` +
          `抽出 ${frames.length}/${count} 帧（缓存命中 ${frames.filter((f) => f.cacheHit).length}）：` +
          frames.map((f) => `${formatTime(f.time)}${f.cacheHit ? '（缓存）' : ''}`).join('、'),
      }
      await attachFrames(images, frames, rel.split('/').pop() ?? 'video', textRef)
      const value: VisionToolValue = { tool: FRAMES_TOOL_NAME, ok: frames.length > 0, text: textRef.text, videoPath: rel, images }
      return JSON.parse(JSON.stringify(value)) as VisionToolValue
    },
  }

  return [skim, framesTool]
}

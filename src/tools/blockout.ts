// huabu_blockout 工具：参数校验、工作区路径安全带、引擎参数组装、video 成片发布。
// B3 只返回文本结果；B4 起 sheet/view/keyframes 的拼版图经 attachments 回喂。
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, stat, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import type { BlockoutAction, BlockoutService, EngineRunResult, WorkingDirectoryLike } from '../services/blockout'
import { resolveSessionCwd } from '../services/blockout'

export const BLOCKOUT_TOOL_NAME = 'huabu_blockout'

export const BLOCKOUT_ACTIONS: readonly BlockoutAction[] = [
  'check',
  'describe',
  'sheet',
  'view',
  'shot',
  'shots',
  'video',
]

const VIEW_NAMES = ['front', 'right', 'top', 'threequarter'] as const
type ViewName = (typeof VIEW_NAMES)[number]

const MIN_SHEET_SIZE = 128
const MIN_IMAGE_EDGE = 16

export interface DshToolExecLike {
  cwd?: string
  agent?: unknown
  signal?: AbortSignal
}

export interface AttachmentServiceLike {
  saveImage(input: { data: Buffer; mediaType: string; name?: string }): Promise<unknown>
}

export interface BlockoutToolContext {
  workingDirectory?: WorkingDirectoryLike
  attachments?: AttachmentServiceLike
}

export interface BlockoutServiceLike {
  readonly version: string
  timeoutFor(action: BlockoutAction): number
  run(args: string[], options: Parameters<BlockoutService['run']>[1]): Promise<EngineRunResult>
}

export interface PublishedVideo {
  relPath: string
  bytes: number
}

/** attachment ref 只保留纯标量字段：execute 返回值必须可无损 JSON 往返（A4 契约 #4） */
export interface AttachmentRef {
  attachmentId: string
  mediaType?: string
  name?: string
  width?: number
  height?: number
  bytes?: number
}

export interface BlockoutToolValue {
  engine: string
  action: BlockoutAction
  ok: boolean
  code: number
  scene: string
  text: string
  cancelled?: boolean
  published?: PublishedVideo
  images?: AttachmentRef[]
}

export interface DshToolDefLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: Record<string, unknown>, value: BlockoutToolValue): unknown
  }
  timeoutMs: number
  execute(args: Record<string, unknown>, exec: DshToolExecLike): Promise<BlockoutToolValue>
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    engine: { type: 'string' },
    action: { type: 'string' },
    ok: { type: 'boolean' },
    code: { type: 'number' },
    scene: { type: 'string' },
    text: { type: 'string' },
    cancelled: { type: 'boolean' },
    published: {
      type: 'object',
      properties: {
        relPath: { type: 'string' },
        bytes: { type: 'number' },
      },
      required: ['relPath'],
    },
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
  required: ['engine', 'action', 'ok', 'code', 'scene', 'text'],
}

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...BLOCKOUT_ACTIONS],
      description:
        'check=数值自检(解算+碰撞) / describe=解算数字表 / sheet=四视图拼版 / view=单视图 / shot=运镜解算 / shots=全部镜头+连续性 / video=渲染成片mp4',
    },
    scene: {
      type: 'string',
      description: 'author 场景文件的工作区相对路径（数据格式见 huabu-blockout 技能）',
    },
    shot: { type: 'string', description: '镜头 id（shot/video 用；缺省取场景第一个镜头）' },
    view: {
      type: 'string',
      enum: [...VIEW_NAMES],
      description: '视图名（view 动作用）：front / right / top / threequarter，缺省 threequarter',
    },
    keyframes: { type: 'boolean', description: 'shot 动作附带关键帧拼版 PNG（视觉自检构图节奏）' },
    width: { type: 'number', description: '画幅宽（view 默认 800 / video 默认 640）' },
    height: { type: 'number', description: '画幅高（view 默认 600 / video 默认 360）' },
    size: {
      type: 'number',
      description: '拼版边长像素（sheet / keyframes，默认 1024；建议 ≥1024 保证每格可读）',
    },
    out: {
      type: 'string',
      description: '输出文件的工作区相对路径（缺省落 .huabu/blockout/<场景>/）',
    },
    publish: {
      type: 'boolean',
      description: 'video 成片是否发布到素材库 assets/video（默认 true；同镜头重渲染覆盖旧成片）',
    },
  },
  required: ['action', 'scene'],
}

/* ── 路径安全带 ──────────────────────────────────────────── */

/** 解析后必须落在工作区内；工作区根本身不算合法文件路径 */
export function insideWorkspace(workspaceDir: string, candidate: string): boolean {
  const rel = relative(resolvePath(workspaceDir), resolvePath(candidate))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** author 文件名 → 场景短名（目录与成片命名用） */
export function sceneStem(scenePath: string): string {
  return basename(scenePath).replace(/(\.author)?\.json$/i, '') || 'scene'
}

/** 只保留安全文件名字符；空结果回退到 fallback */
function safeName(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return (cleaned || fallback).slice(0, 80)
}

export function assetNameOf(stem: string, shot: string): string {
  return `${safeName(stem, 'scene')}-${safeName(shot, 'shot')}`
}

function workspaceRel(workspaceDir: string, absPath: string): string {
  return relative(workspaceDir, absPath).replace(/\\/g, '/')
}

/* ── 参数校验与引擎参数组装 ──────────────────────────────── */

interface ParsedArgs {
  action: BlockoutAction
  scene: string
  shot?: string
  view?: ViewName
  keyframes: boolean
  width?: number
  height?: number
  size?: number
  out?: string
  publish: boolean
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  const trimmed = value.trim()
  return trimmed || undefined
}

function optionalInt(value: unknown, field: string, min: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} 必须是数字`)
  const rounded = Math.round(value)
  if (rounded < min) throw new Error(`${field} 不能小于 ${min}`)
  return rounded
}

export function parseToolArgs(raw: Record<string, unknown>): ParsedArgs {
  const action = raw.action
  if (typeof action !== 'string' || !(BLOCKOUT_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(
      `未知 action：「${String(action)}」；可用：${BLOCKOUT_ACTIONS.join(' / ')}`,
    )
  }
  const scene = typeof raw.scene === 'string' ? raw.scene.trim() : ''
  if (!scene) throw new Error('缺少 scene 参数（author 场景文件的工作区相对路径）')

  const shot = optionalText(raw.shot, 'shot')
  const view = optionalText(raw.view, 'view')
  if (view !== undefined && !(VIEW_NAMES as readonly string[]).includes(view)) {
    throw new Error(`未知 view：「${view}」；可用：${VIEW_NAMES.join(' / ')}`)
  }
  if (raw.keyframes !== undefined && typeof raw.keyframes !== 'boolean') {
    throw new Error('keyframes 必须是布尔值')
  }
  if (raw.publish !== undefined && typeof raw.publish !== 'boolean') {
    throw new Error('publish 必须是布尔值')
  }

  const width = optionalInt(raw.width, 'width', MIN_IMAGE_EDGE)
  const height = optionalInt(raw.height, 'height', MIN_IMAGE_EDGE)
  const size = optionalInt(raw.size, 'size', MIN_SHEET_SIZE)
  const out = optionalText(raw.out, 'out')

  return {
    action: action as BlockoutAction,
    scene,
    ...(shot !== undefined ? { shot } : {}),
    ...(view !== undefined ? { view: view as ViewName } : {}),
    keyframes: raw.keyframes === true,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(out !== undefined ? { out } : {}),
    publish: raw.publish !== false,
  }
}

export interface EngineArgsInput {
  action: BlockoutAction
  sceneAbs: string
  shot?: string
  view?: ViewName
  keyframes: boolean
  width?: number
  height?: number
  size?: number
  outAbs?: string
  workDirAbs: string
}

export function buildEngineArgs(input: EngineArgsInput): string[] {
  const args: string[] = [input.action, '--scene', input.sceneAbs]
  const shotFile = input.shot ?? 'shot'

  if (input.action === 'sheet') {
    args.push('--out', input.outAbs ?? join(input.workDirAbs, 'sheet.png'))
    if (input.size !== undefined) args.push('--size', String(input.size))
  } else if (input.action === 'view') {
    const view = input.view ?? 'threequarter'
    args.push('--view', view, '--out', input.outAbs ?? join(input.workDirAbs, `view-${view}.png`))
    if (input.width !== undefined) args.push('--width', String(input.width))
    if (input.height !== undefined) args.push('--height', String(input.height))
  } else if (input.action === 'shot') {
    if (input.shot) args.push('--shot', input.shot)
    if (input.keyframes) {
      args.push('--sheet')
      args.push('--out', input.outAbs ?? join(input.workDirAbs, `${shotFile}-keys.png`))
      if (input.size !== undefined) args.push('--size', String(input.size))
    } else {
      args.push('--out', input.outAbs ?? join(input.workDirAbs, `${shotFile}.frames.json`))
    }
  } else if (input.action === 'video') {
    if (input.shot) args.push('--shot', input.shot)
    if (input.width !== undefined) args.push('--width', String(input.width))
    if (input.height !== undefined) args.push('--height', String(input.height))
    args.push('--out', input.outAbs ?? join(input.workDirAbs, `${shotFile}.mp4`))
    args.push('--progress')
  }
  return args
}

/* ── 成片发布 ────────────────────────────────────────────── */

async function publishVideo(
  workspaceDir: string,
  videoAbs: string,
  stem: string,
  shot: string,
): Promise<PublishedVideo> {
  const name = `${assetNameOf(stem, shot)}.mp4`
  const dir = join(workspaceDir, 'assets', 'video')
  const dest = join(dir, name)
  await mkdir(dir, { recursive: true })
  // 同镜头唯一成片：先删旧文件，避免 copyFile 在部分平台写入失败
  if (existsSync(dest)) await unlink(dest).catch(() => undefined)
  await copyFile(videoAbs, dest)
  const info = await stat(dest)
  return { relPath: `assets/video/${name}`, bytes: info.size }
}

/* ── 引擎结果解读 ────────────────────────────────────────── */

/** 哪些 action 的产物是一张要看/要回喂的 PNG */
export function imagePathFor(
  action: BlockoutAction,
  parsed: Record<string, unknown> | null,
  keyframes: boolean,
): string | null {
  const producesImage = action === 'sheet' || action === 'view' || (action === 'shot' && keyframes)
  if (!producesImage) return null
  return typeof parsed?.image === 'string' ? parsed.image : null
}

function plainAttachmentRef(raw: unknown): AttachmentRef | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.attachmentId !== 'string' || !rec.attachmentId) return null
  const ref: AttachmentRef = { attachmentId: rec.attachmentId }
  if (typeof rec.mediaType === 'string') ref.mediaType = rec.mediaType
  if (typeof rec.name === 'string') ref.name = rec.name
  if (typeof rec.width === 'number' && Number.isFinite(rec.width)) ref.width = rec.width
  if (typeof rec.height === 'number' && Number.isFinite(rec.height)) ref.height = rec.height
  if (typeof rec.bytes === 'number' && Number.isFinite(rec.bytes)) ref.bytes = rec.bytes
  return ref
}

function failureDetail(run: EngineRunResult): string {
  const stderr = run.stderr.trim()
  if (stderr) return stderr.slice(0, 500)
  try {
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>
    const detail = parsed.message ?? parsed.error ?? parsed.errors
    if (detail !== undefined) return JSON.stringify(detail).slice(0, 500)
  } catch {
    /* stdout 不是 JSON */
  }
  return run.stdout.trim().slice(0, 400)
}

function resultHeader(version: string, action: BlockoutAction, code: number, shot?: string): string {
  const suffix =
    code === 2
      ? ' · 解算有 error（修改 author 数据后重跑）'
      : code === 3
        ? ' · 约束违规（按引擎 errors/warnings 修改 author 后重跑）'
        : ''
  return `[blockout engine v${version} · ${action}${shot ? ` ${shot}` : ''}${suffix}]`
}

/* ── 工具定义 ────────────────────────────────────────────── */

export function assembleBlockoutTool(
  ctx: BlockoutToolContext,
  service: BlockoutServiceLike,
): DshToolDefLike {
  return {
    name: BLOCKOUT_TOOL_NAME,
    description:
      '运行 Huabu blockout 粗模/运镜引擎（本地零成本）：数值自检、四视图拼版、单视图、运镜解算、预览成片。' +
      'action=check 解算+碰撞自检；describe 输出解算数字表；sheet 出四视图拼版 PNG；view 出单视图 PNG；' +
      'shot 解算运镜（keyframes=true 出关键帧拼版）；shots 解算全部镜头与连续性；video 渲染 MP4 并默认发布到素材库。' +
      'scene 必须是工作区相对路径的 author JSON；工作产物默认落 .huabu/blockout/<场景>/。' +
      '完整 author 数据格式与运镜字段见 huabu-blockout 技能：不要直接跑引擎脚本。',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: value.text }]
        for (const image of value.images ?? []) blocks.push({ type: 'image', attachment: image })
        return blocks
      },
    },
    timeoutMs: 300_000,
    async execute(rawArgs, exec) {
      const input = parseToolArgs(rawArgs)
      const workspaceDir = await resolveSessionCwd(ctx, exec)

      const sceneAbs = resolvePath(workspaceDir, input.scene)
      if (!insideWorkspace(workspaceDir, sceneAbs)) {
        throw new Error(`scene 路径越出工作区：${input.scene}（必须使用工作区内的相对路径）`)
      }
      if (!existsSync(sceneAbs)) {
        throw new Error(
          `场景文件不存在：${input.scene}（先用 write 写 author JSON，数据格式见 huabu-blockout 技能）`,
        )
      }
      const sceneStat = await stat(sceneAbs)
      if (!sceneStat.isFile()) throw new Error(`scene 不是常规文件：${input.scene}`)

      let outAbs: string | undefined
      if (input.out) {
        outAbs = resolvePath(workspaceDir, input.out)
        if (!insideWorkspace(workspaceDir, outAbs)) {
          throw new Error(`out 路径越出工作区：${input.out}（必须使用工作区内的相对路径）`)
        }
      }

      const stem = sceneStem(input.scene)
      const workDirAbs = join(workspaceDir, '.huabu', 'blockout', safeName(stem, 'scene'))
      const engineArgs = buildEngineArgs({
        action: input.action,
        sceneAbs,
        ...(input.shot !== undefined ? { shot: input.shot } : {}),
        ...(input.view !== undefined ? { view: input.view } : {}),
        keyframes: input.keyframes,
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
        ...(input.size !== undefined ? { size: input.size } : {}),
        ...(outAbs !== undefined ? { outAbs } : {}),
        workDirAbs,
      })

      const run = await service.run(engineArgs, {
        cwd: workspaceDir,
        timeoutMs: service.timeoutFor(input.action),
        ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      })

      if (run.spawnError) {
        throw new Error(`[blockout engine v${service.version}] 引擎不可用：${run.spawnError}`)
      }
      if (run.aborted) {
        return {
          engine: service.version,
          action: input.action,
          ok: false,
          code: run.code,
          scene: input.scene,
          text: `[blockout engine v${service.version}] ${input.action} 已取消（用户中断），子进程已终止；如需继续请重新发起。`,
          cancelled: true,
        }
      }
      if (run.timedOut) {
        const seconds = Math.round(service.timeoutFor(input.action) / 1000)
        throw new Error(
          `[blockout engine v${service.version}] ${input.action} 超时（${seconds}s）被中止；` +
            '可降低 size/画幅/时长或简化场景后重试。',
        )
      }
      if (run.code === 1) {
        throw new Error(
          `[blockout engine v${service.version}] ${input.action} 执行失败（用法/IO）：${failureDetail(run)}`,
        )
      }
      if (run.code !== 0 && run.code !== 2 && run.code !== 3) {
        throw new Error(
          `[blockout engine v${service.version}] ${input.action} 异常退出（code=${run.code}）：${failureDetail(run)}`,
        )
      }

      let parsed: Record<string, unknown> | null = null
      try {
        parsed = JSON.parse(run.stdout) as Record<string, unknown>
      } catch {
        parsed = null
      }

      let text = `${resultHeader(service.version, input.action, run.code, input.shot)}\n${run.stdout.trimEnd()}`
      let published: PublishedVideo | undefined

      if (input.action === 'video' && run.code === 0 && parsed?.ok === true && input.publish) {
        const rawVideo = typeof parsed.video === 'string' ? parsed.video : outAbs
        const videoAbs = rawVideo !== undefined ? resolvePath(workspaceDir, rawVideo) : undefined
        if (videoAbs && insideWorkspace(workspaceDir, videoAbs) && existsSync(videoAbs)) {
          const shotName = typeof parsed.shot === 'string' ? parsed.shot : (input.shot ?? 'shot')
          try {
            published = await publishVideo(workspaceDir, videoAbs, stem, shotName)
            text += `\n成片已发布到素材库：${published.relPath}（${Math.max(1, Math.round(published.bytes / 1024))}KB）`
          } catch (error) {
            text += `\n（成片发布到素材库失败：${error instanceof Error ? error.message : String(error)}；文件仍在 ${workspaceRel(workspaceDir, videoAbs)}）`
          }
        } else if (videoAbs) {
          text += `\n（成片未发布：引擎输出路径不在工作区内：${videoAbs}）`
        }
      }

      const images: AttachmentRef[] = []
      const imagePath = run.code === 0 ? imagePathFor(input.action, parsed, input.keyframes) : null
      if (imagePath) {
        const imageAbs = resolvePath(workspaceDir, imagePath)
        const relPath = workspaceRel(workspaceDir, imageAbs)
        if (!insideWorkspace(workspaceDir, imageAbs) || !existsSync(imageAbs)) {
          text += `\n（图片未回喂：产物不在工作区或不存在：${imagePath}）`
        } else {
          try {
            const png = await readFile(imageAbs)
            const isPng = png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
            const save = ctx.attachments?.saveImage
            if (!isPng) {
              text += `\n（图片未回喂：产物不是 PNG；文件仍在 ${relPath}）`
            } else if (typeof save !== 'function') {
              text += `\n（图片未回喂：附件服务不可用；文件仍在 ${relPath}）`
            } else {
              const rawRef = await save.call(ctx.attachments, {
                data: png,
                mediaType: 'image/png',
                name: basename(imageAbs),
              })
              const ref = plainAttachmentRef(rawRef)
              if (ref) {
                images.push(ref)
                text += `\n图片已随本条结果附上（文件：${relPath}）；数值与图对照着看，不要从像素里量坐标。`
              } else {
                text += `\n（图片未回喂：saveImage 返回值缺少 attachmentId；文件仍在 ${relPath}）`
              }
            }
          } catch (error) {
            text += `\n（图片回喂失败：${error instanceof Error ? error.message : String(error)}；文件仍在 ${relPath}）`
          }
        }
      }

      const value: BlockoutToolValue = {
        engine: service.version,
        action: input.action,
        ok: run.code === 0 && parsed?.ok !== false,
        code: run.code,
        scene: input.scene,
        text,
        ...(published !== undefined ? { published } : {}),
        ...(images.length > 0 ? { images } : {}),
      }
      // 宿主契约 #4：返回值必须可无损 JSON 往返
      return JSON.parse(JSON.stringify(value)) as BlockoutToolValue
    },
  }
}

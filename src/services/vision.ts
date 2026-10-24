// huabu.vision 服务（F1/F3）：ffmpeg 探测链（config → env → ffmpeg-static → PATH）、
// 视频元数据（ffmpeg -i stderr 解析）、区间抽帧（.huabu/vframes 缓存）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire as nodeCreateRequire } from 'node:module'
import { join } from 'node:path'

// 宿主构建的 banner 已声明 createRequire/require；别名导入避免顶层重复声明，
// 单独打包（单测）时 banner 缺席则本地兜底
const requireCjs: NodeRequire =
  typeof require === 'function' ? require : nodeCreateRequire(import.meta.url)

export const VISION_SERVICE_VERSION = '0.1.0'

export interface VisionConfig {
  /** ffmpeg 显式路径（插件 config.media.ffmpegPath / config.ffmpegPath） */
  ffmpegPath?: string
}

export interface FfmpegSource {
  path: string
  /** 探测来源：config / env(FFMPEG/FFMPEG_PATH) / ffmpeg-static / PATH */
  source: 'config' | 'env' | 'ffmpeg-static' | 'PATH'
}

/** F1：ffmpeg 探测链。返回 null = 全无（调用方给安装指引），不抛错 */
export function resolveFfmpeg(config: VisionConfig = {}): FfmpegSource | null {
  if (config.ffmpegPath && existsSync(config.ffmpegPath)) return { path: config.ffmpegPath, source: 'config' }
  for (const name of ['FFMPEG_PATH', 'FFMPEG'] as const) {
    const value = process.env[name]
    if (value && existsSync(value)) return { path: value, source: 'env' }
  }
  try {
    // ffmpeg-static 为 optionalDependency（二进制可能未随 postinstall 下载，existsSync 校验）；
    // createRequire 走运行时解析，构建期 external（B2 同款手法）
    const candidate = requireCjs('ffmpeg-static') as unknown as { default?: string } | string
    const path = typeof candidate === 'string' ? candidate : candidate?.default
    if (path && existsSync(path)) return { path, source: 'ffmpeg-static' }
  } catch {
    /* 未安装可选依赖 */
  }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], {
    windowsHide: true,
    timeout: 10_000,
  })
  const hit = (which.stdout ?? '').toString().split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  if (hit && existsSync(hit)) return { path: hit, source: 'PATH' }
  // where/which 在部分环境（CI runner）不可用：直接探测可执行（PATH 由 CreateProcess 解析）
  const probe = spawnSync('ffmpeg', ['-version'], { windowsHide: true, timeout: 10_000 })
  if (probe.status === 0) return { path: 'ffmpeg', source: 'PATH' }
  return null
}

export interface VideoMeta {
  durationSeconds: number
  width?: number
  height?: number
  fps?: number
}

/** ffmpeg -i 的 stderr 解析元数据（无 ffprobe 依赖）：Duration/Stream 分辨率与帧率 */
export function parseFfmpegMeta(stderr: string): VideoMeta {
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const durationSeconds = duration
    ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
    : 0
  const stream = /Stream #\d+:\d+.*?: Video:.*?, (\d{2,5})x(\d{2,5})/.exec(stderr)
  const fps = /(\d+(?:\.\d+)?) fps/.exec(stderr)
  return {
    durationSeconds,
    ...(stream ? { width: Number(stream[1]), height: Number(stream[2]) } : {}),
    ...(fps ? { fps: Number(fps[1]) } : {}),
  }
}

export interface FrameRequest {
  /** 视频绝对路径 */
  videoPath: string
  /** 抽帧时刻（秒） */
  times: number[]
  /** 输出最长边（默认 768） */
  maxEdge?: number
  /** 缓存目录（绝对路径；缺省不缓存） */
  cacheDir?: string
}

export interface FrameResult {
  time: number
  png: Buffer
  cacheHit: boolean
}

function cacheKey(videoPath: string, time: number, maxEdge: number): string | null {
  try {
    const st = statSync(videoPath)
    const hash = createHash('sha256')
    hash.update(`${videoPath}|${st.size}|${Math.floor(st.mtimeMs)}|${time.toFixed(2)}|${maxEdge}`)
    return hash.digest('hex').slice(0, 24)
  } catch {
    return null
  }
}

/**
 * 抽帧：逐时刻 `-ss T -i video -frames:v 1 -vf scale` 输出 PNG。
 * 缓存命中直接读 .huabu/vframes/<key>.png；ffmpeg 产物先写 <key>.tmp 再改名（防半截 PNG 进缓存）。
 */
export function extractFrames(ffmpeg: string, request: FrameRequest): FrameResult[] {
  const maxEdge = request.maxEdge ?? 768
  const out: FrameResult[] = []
  if (request.cacheDir) mkdirSync(request.cacheDir, { recursive: true })
  for (const rawTime of request.times) {
    const time = Math.max(0, rawTime)
    const key = request.cacheDir ? cacheKey(request.videoPath, time, maxEdge) : null
    const cached = key ? join(request.cacheDir!, `${key}.png`) : null
    if (cached && existsSync(cached)) {
      try {
        out.push({ time, png: readFileSync(cached), cacheHit: true })
        continue
      } catch {
        /* 缓存读失败重抽 */
      }
    }
    const target = cached ?? join(request.cacheDir ?? '.', `frame-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
    const tmp = `${target}.tmp.png`
    const run = spawnSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-ss', time.toFixed(2), '-i', request.videoPath, '-frames:v', '1', '-vf', `scale='min(${maxEdge},iw)':-2`, tmp],
      { windowsHide: true, timeout: 30_000 },
    )
    if (run.status !== 0 || !existsSync(tmp)) continue
    const png = readFileSync(tmp)
    unlinkSync(tmp)
    if (cached) writeFileSync(target, png)
    out.push({ time, png, cacheHit: false })
  }
  return out
}

/** 元数据探测：ffmpeg -i（不带输出文件）必以非零退出，stderr 里有 Duration/Stream */
export function probeVideo(ffmpeg: string, videoPath: string): VideoMeta {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-i', videoPath], { windowsHide: true, timeout: 30_000 })
  return parseFfmpegMeta((run.stderr ?? '').toString())
}

/** 生成均匀时间轴：[0, duration) 内 count 个点（首帧 0，末点留出余量避免越界） */
export function evenTimeline(durationSeconds: number, count: number): number[] {
  if (durationSeconds <= 0 || count <= 0) return []
  if (count === 1) return [0]
  const usable = Math.max(0.1, durationSeconds - 0.1)
  return Array.from({ length: count }, (_, i) => Number(((usable * i) / (count - 1)).toFixed(2)))
}

/** 缓存目录里现存的帧数（测试/诊断用） */
export function cachedFrameCount(cacheDir: string): number {
  try {
    return readdirSync(cacheDir).filter((name) => name.endsWith('.png')).length
  } catch {
    return 0
  }
}

export class VisionService {
  readonly version = VISION_SERVICE_VERSION
  constructor(private readonly config: VisionConfig = {}) {}

  ffmpeg(): FfmpegSource | null {
    return resolveFfmpeg(this.config)
  }

  /** 元数据；缺 ffmpeg 时抛可操作错误（含四来源指引） */
  probe(videoPath: string): VideoMeta {
    const ffmpeg = this.ffmpeg()
    if (!ffmpeg) {
      throw new Error(
        '未找到 ffmpeg（已按顺序探测：插件配置 media.ffmpegPath → 环境变量 FFMPEG_PATH/FFMPEG → 插件依赖 ffmpeg-static → PATH）。' +
          '请安装 ffmpeg 并让 PATH 可见，或在插件配置里指定 ffmpegPath。',
      )
    }
    return probeVideo(ffmpeg.path, videoPath)
  }

  frames(request: FrameRequest): FrameResult[] {
    const ffmpeg = this.ffmpeg()
    if (!ffmpeg) {
      throw new Error(
        '未找到 ffmpeg（已按顺序探测：插件配置 media.ffmpegPath → 环境变量 FFMPEG_PATH/FFMPEG → 插件依赖 ffmpeg-static → PATH）。',
      )
    }
    return extractFrames(ffmpeg.path, request)
  }
}

export const VFRAMES_DIR_REL = '.huabu/vframes'
export const VIDEO_FRAME_MAX_EDGE = 768
// huabu.blockout 服务：定位随包引擎、子进程执行、超时/取消、输出收集与进度解析。
// 只依赖 Node，不依赖 ctx.tools / ctx.attachments，方便单测（B2）。
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 引擎版本（CLI 无自曝能力，SKILL.md 与工具输出共用此版本戳） */
export const BLOCKOUT_ENGINE_VERSION = '0.2.0-mvp'
export const BLOCKOUT_CLI_FILE = 'cli.mjs'
/** 数值动作 60s（实测 <1s）；video 渲染 + 编码给 5 分钟 */
export const BLOCKOUT_TIMEOUT_MS = { numeric: 60_000, video: 300_000 } as const

const STDOUT_CAP = 4 * 1024 * 1024
const STDERR_CAP = 64 * 1024
const KILL_GRACE_MS = 2_000
const PROGRESS_RE = /渲染\s*(\d+)\s*\/\s*(\d+)/

export type BlockoutAction = 'check' | 'describe' | 'sheet' | 'view' | 'shot' | 'shots' | 'video'

export interface EngineProgress {
  done: number
  total: number
}

export interface EngineRunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  spawnError: string | null
  durationMs: number
  progress: EngineProgress[]
}

export interface EngineRunOptions {
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  /** 测试/特殊部署可覆盖引擎目录；缺省为随包 lib/blockout */
  engineDir?: string
  onProgress?: (progress: EngineProgress) => void
  env?: NodeJS.ProcessEnv
}

/** 构建产物中 host bundle 位于 lib/index.js，引擎与其同级在 lib/blockout/ */
const DEFAULT_ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'blockout')

export function resolveEngineCli(engineDir = DEFAULT_ENGINE_DIR): string | null {
  const cli = join(engineDir, BLOCKOUT_CLI_FILE)
  try {
    return statSync(cli).isFile() ? cli : null
  } catch {
    return null
  }
}

/** 杀整棵子进程树：video 的 ffmpeg 是引擎 spawnSync 的孙进程，只杀父进程不够（win32 主战场） */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
  }
}

/** 引擎向上找 node_modules 的逻辑到不了插件安装目录，ffmpeg 需显式给（可选依赖，缺省交给引擎自寻） */
async function resolveFfmpeg(): Promise<string | undefined> {
  const override = process.env.BLOCKOUT_FFMPEG
  if (override && existsSync(override)) return override
  try {
    const mod = await import('ffmpeg-static')
    const candidate = mod.default
    if (typeof candidate === 'string' && existsSync(candidate)) return candidate
  } catch {
    /* 未安装可选依赖 */
  }
  return undefined
}

function emptyResult(startedAt: number): EngineRunResult {
  return {
    code: -1,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: false,
    spawnError: null,
    durationMs: Date.now() - startedAt,
    progress: [],
  }
}

export async function runEngineCli(args: string[], options: EngineRunOptions): Promise<EngineRunResult> {
  const startedAt = Date.now()
  const cli = resolveEngineCli(options.engineDir)
  if (!cli) {
    const result = emptyResult(startedAt)
    result.spawnError = `引擎文件缺失：${join(options.engineDir ?? DEFAULT_ENGINE_DIR, BLOCKOUT_CLI_FILE)}`
    return result
  }
  if (options.signal?.aborted) {
    const result = emptyResult(startedAt)
    result.aborted = true
    return result
  }

  const ffmpeg = args[0] === 'video' ? await resolveFfmpeg() : undefined
  if (options.signal?.aborted) {
    const result = emptyResult(startedAt)
    result.aborted = true
    return result
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ...(ffmpeg ? { BLOCKOUT_FFMPEG: ffmpeg } : {}),
    ...options.env,
  }

  return await new Promise<EngineRunResult>((settle) => {
    let child: ChildProcess
    try {
      child = spawn(process.execPath, [cli, ...args], {
        cwd: options.cwd,
        windowsHide: true,
        // POSIX 下自成进程组，取消时可整组杀（win32 走 taskkill /T）
        detached: process.platform !== 'win32',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const result = emptyResult(startedAt)
      result.spawnError = String(error)
      settle(result)
      return
    }

    let stdout = ''
    let stderr = ''
    const progress: EngineProgress[] = []
    let timedOut = false
    let aborted = false
    let spawnError: string | null = null
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let fallback: ReturnType<typeof setTimeout> | undefined

    const finish = (code?: number | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (fallback) clearTimeout(fallback)
      options.signal?.removeEventListener('abort', onAbort)
      settle({
        code: code ?? child.exitCode ?? -1,
        stdout,
        stderr,
        timedOut,
        aborted,
        spawnError,
        durationMs: Date.now() - startedAt,
        progress,
      })
    }

    const kill = () => {
      killProcessTree(child.pid ?? -1)
      // kill 后正常会收到 exit；兜底 2s 强制结算，防止僵死进程挂住工具
      fallback ??= setTimeout(() => finish(null), KILL_GRACE_MS)
    }

    const onAbort = () => {
      if (settled) return
      aborted = true
      kill()
    }

    timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      kill()
    }, options.timeoutMs ?? BLOCKOUT_TIMEOUT_MS.numeric)

    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length >= STDOUT_CAP) return
      stdout += chunk.slice(0, STDOUT_CAP - stdout.length)
    })

    let stderrTail = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.slice(0, STDERR_CAP - stderr.length)
      stderrTail = (stderrTail + chunk).slice(-4096)
      for (;;) {
        const match = PROGRESS_RE.exec(stderrTail)
        if (!match) {
          if (stderrTail.length > 2048) stderrTail = stderrTail.slice(-2048)
          break
        }
        stderrTail = stderrTail.slice(match.index + match[0].length)
        const done = Number(match[1])
        const total = Number(match[2])
        if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) continue
        const event: EngineProgress = { done, total }
        progress.push(event)
        options.onProgress?.(event)
      }
    })

    child.on('error', (error) => {
      spawnError = String(error)
      finish(null)
    })
    child.on('exit', (code) => finish(code))
  })
}

export class BlockoutService {
  readonly version = BLOCKOUT_ENGINE_VERSION

  resolveCli(): string | null {
    return resolveEngineCli()
  }

  timeoutFor(action: BlockoutAction): number {
    return action === 'video' ? BLOCKOUT_TIMEOUT_MS.video : BLOCKOUT_TIMEOUT_MS.numeric
  }

  run(args: string[], options: EngineRunOptions): Promise<EngineRunResult> {
    return runEngineCli(args, options)
  }
}

/* ── 会话工作区（A4 契约 #5）：实现已抽到 session-cwd，供 project 服务共用 ── */
export { resolveSessionCwd } from './session-cwd'
export type { ToolExecLike, WorkingDirectoryLike } from './session-cwd'
// huabu.project 服务（C1）：会话 cwd 绑定、workspace.json 只改 media 段、
// 工作区相对路径白名单与 realpath 防逃逸。只依赖 Node，不依赖 ctx.tools，方便单测。
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { atomicWriteSync, recoverAtomicBackupSync } from './fs-atomic'
import { resolveSessionCwd, type ToolExecLike, type WorkingDirectoryLike } from './session-cwd'

export const PROJECT_SERVICE_VERSION = '0.1.0'
export const WORKSPACE_META_FILE = '.huabu/workspace.json'
/** 插件产物只允许写这两个根（设计 §6.5）；读取不受此限制 */
export const WRITE_ROOTS = ['.huabu', 'assets'] as const

export type JsonObject = Record<string, unknown>
export type WorkspaceMeta = JsonObject & { version?: number }
export type MediaUpdater = (media: JsonObject) => JsonObject | void

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function within(root: string, target: string): boolean {
  const normalize = (p: string) => {
    const trimmed = p.replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
  }
  const base = normalize(root)
  const value = normalize(target)
  if (value === base) return true
  const sep = process.platform === 'win32' ? '\\' : '/'
  return value.startsWith(`${base}${sep}`)
}

/** 工作区相对路径 → 段数组：拒绝绝对路径、盘符、UNC、NUL 与越界 .. */
function splitRelative(rel: string): string[] {
  if (typeof rel !== 'string') throw new Error('路径必须是字符串')
  const value = rel.trim()
  if (!value) throw new Error('路径不能为空')
  if (value.includes('\0')) throw new Error(`路径包含非法字符：${rel}`)
  const posix = value.replace(/\\/g, '/')
  if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) {
    throw new Error(`路径必须是工作区相对路径（不接受绝对路径）：${rel}`)
  }
  const segments: string[] = []
  for (const segment of posix.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) throw new Error(`路径越出工作区，已拒绝：${rel}`)
      segments.pop()
      continue
    }
    if (process.platform === 'win32' && segment.includes(':')) {
      throw new Error(`路径包含 Windows 备用数据流分隔符，已拒绝：${rel}`)
    }
    segments.push(segment)
  }
  if (segments.length === 0) throw new Error(`路径解析后为空，已拒绝：${rel}`)
  return segments
}

/** 会话工作区句柄：所有落盘路径都必须经过它，避免工具各自拼路径 */
export class Project {
  readonly root: string

  constructor(cwd: string) {
    const abs = resolvePath(cwd)
    let real: string
    try {
      real = realpathSync.native(abs)
    } catch {
      throw new Error(`工作区不存在或不可访问：${cwd}`)
    }
    if (!statSync(real).isDirectory()) throw new Error(`工作区不是目录：${cwd}`)
    this.root = real
  }

  get metaFile(): string {
    return join(this.root, WORKSPACE_META_FILE)
  }

  /** 读 workspace.json；文件不存在返回 {version:1} 且不落盘。损坏时抛错，绝不静默覆盖 */
  readMeta(): WorkspaceMeta {
    recoverAtomicBackupSync(this.metaFile)
    if (!existsSync(this.metaFile)) return { version: 1 }
    return this.parseMeta(readFileSync(this.metaFile, 'utf8'))
  }

  getMedia(): JsonObject {
    const meta = this.readMeta()
    return isRecord(meta.media) ? { ...meta.media } : {}
  }

  /**
   * 只改 media 段：其余段与未知字段原样保留；updater 可直接删键或返回新对象。
   * 写前恢复 .bak；解析失败直接抛错，不拿空对象覆盖用户文件。
   */
  updateMedia(update: MediaUpdater): WorkspaceMeta {
    recoverAtomicBackupSync(this.metaFile)
    let raw: JsonObject = {}
    if (existsSync(this.metaFile)) raw = this.parseMeta(readFileSync(this.metaFile, 'utf8'))

    const draft: JsonObject = isRecord(raw.media) ? { ...raw.media } : {}
    const returned = update(draft)
    const media = isRecord(returned) ? returned : draft
    const next: WorkspaceMeta = {
      ...raw,
      version: typeof raw.version === 'number' ? raw.version : 1,
      media,
    }
    atomicWriteSync(this.metaFile, JSON.stringify(next, null, 2))
    return next
  }

  /** 读路径：工作区相对，任意子目录；折叠 . / .. 后仍须在根内（realpath 防软链逃逸） */
  resolve(rel: string): string {
    return this.resolveSegments(splitRelative(rel))
  }

  /** 写路径：额外限制在 .huabu/** 或 assets/**；allowRoot 供 ensureDir('.huabu') 这类目录使用 */
  resolveWrite(rel: string, options: { allowRoot?: boolean } = {}): string {
    const segments = splitRelative(rel)
    const top = segments[0]
    if (!(WRITE_ROOTS as readonly string[]).includes(top)) {
      throw new Error(`写入路径只允许 ${WRITE_ROOTS.map((r) => `${r}/**`).join(' 与 ')}：${rel}`)
    }
    if (segments.length < 2 && options.allowRoot !== true) {
      throw new Error(`写入路径必须指向 ${top}/ 下的文件或目录：${rel}`)
    }
    return this.resolveSegments(segments)
  }

  ensureDir(rel: string): string {
    const abs = this.resolveWrite(rel, { allowRoot: true })
    mkdirSync(abs, { recursive: true })
    return this.resolveSegments(splitRelative(rel))
  }

  exists(rel: string): boolean {
    try {
      return existsSync(this.resolve(rel))
    } catch {
      return false
    }
  }

  private resolveSegments(segments: string[]): string {
    const abs = join(this.root, ...segments)
    const real = this.realTarget(abs)
    if (!within(this.root, real)) {
      throw new Error(`路径越出工作区，已拒绝：${segments.join('/')}`)
    }
    return real
  }

  /** 存在的部分取 realpath，缺失的尾部拼回去；软链指向根外会在 within 检查处被拒 */
  private realTarget(abs: string): string {
    let cursor = abs
    const missing: string[] = []
    for (;;) {
      try {
        const real = realpathSync.native(cursor)
        return missing.length > 0 ? join(real, ...missing.reverse()) : real
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw new Error(`路径无法解析：${abs}（${error instanceof Error ? error.message : String(error)}）`)
        }
        const parent = dirname(cursor)
        if (parent === cursor) throw new Error(`路径无法解析：${abs}`)
        missing.push(basename(cursor))
        cursor = parent
      }
    }
  }

  private parseMeta(text: string): WorkspaceMeta {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(
        `workspace.json 解析失败（${this.metaFile}）：${error instanceof Error ? error.message : String(error)}；` +
          '请修复或备份后重试，插件不会覆盖它',
      )
    }
    if (!isRecord(parsed)) throw new Error(`workspace.json 根节点必须是对象（${this.metaFile}），插件不会覆盖它`)
    return typeof parsed.version === 'number' ? parsed : { ...parsed, version: 1 }
  }
}

export class ProjectService {
  readonly version = PROJECT_SERVICE_VERSION

  open(cwd: string): Project {
    return new Project(cwd)
  }

  /** 工具侧入口：先经 workingDirectory.ensure 取真实会话 cwd，再绑定句柄 */
  async forExec(ctx: { workingDirectory?: WorkingDirectoryLike }, exec: ToolExecLike): Promise<Project> {
    return this.open(await resolveSessionCwd(ctx, exec))
  }
}

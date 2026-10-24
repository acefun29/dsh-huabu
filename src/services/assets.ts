// huabu.assets 服务（C2）：素材归档、命名库清单、标签索引与搜索。
// 数据契约与桌面 App 同源：assets/<分类>/ 归档（src/shared/assets.ts 的分类表）、
// .huabu/tags.json 标签索引（src/main/assets/tagsIndex.ts 的清洗与容错规则）、
// workspace.json libraries 段命名库（store.ts 的 sanitizeLibraries 口径）。
// 只依赖 Node 与 huabu.project，不依赖 ctx，方便单测。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, resolve as resolvePath } from 'node:path'
import { atomicWriteSync, recoverAtomicBackupSync } from './fs-atomic'
import type { Project } from './project'
import { ProjectService } from './project'
import { resolveSessionCwd, type ToolExecLike, type WorkingDirectoryLike } from './session-cwd'

export const ASSETS_SERVICE_VERSION = '0.1.0'
export const TAGS_FILE_REL = '.huabu/tags.json'
/** 单个素材文件的上限（与 App 的 MAX_IMPORT_BYTES 一致） */
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024
/** 每个库目录列出的文件数上限（目录扫描现算，截断防爆；与 App 一致） */
const MAX_LIBRARY_FILES = 200

/* ── 分类表（逐字段对齐主仓库 src/shared/assets.ts，单一事实来源在上游） ── */

export type AssetKindName = 'image' | 'video' | 'audio' | 'doc' | 'code' | 'other'

export interface AssetCategory {
  id: 'image' | 'doc' | 'audio' | 'video' | 'other'
  dir: string
  label: string
  kind: AssetKindName
  exts: string[]
}

export const ASSET_CATEGORIES: AssetCategory[] = [
  { id: 'image', dir: 'assets/images', label: '图片', kind: 'image', exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'] },
  { id: 'doc', dir: 'assets/documents', label: '文档', kind: 'doc', exts: ['pdf', 'doc', 'docx', 'md', 'txt', 'pptx', 'xlsx', 'csv', 'rtf'] },
  { id: 'audio', dir: 'assets/audio', label: '音频', kind: 'audio', exts: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'] },
  { id: 'video', dir: 'assets/video', label: '视频', kind: 'video', exts: ['mp4', 'mov', 'webm', 'mkv', 'avi'] },
]

export const CODE_EXTS = [
  'ts', 'tsx', 'js', 'jsx', 'json', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'cs', 'rb', 'php',
  'css', 'html', 'sh', 'yml', 'yaml', 'toml',
]

export const OTHER_CATEGORY: AssetCategory = { id: 'other', dir: 'assets/others', label: '其他', kind: 'other', exts: [] }

export function categorizeFileName(name: string): { category: AssetCategory; kind: AssetKindName } {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const hit = ASSET_CATEGORIES.find((c) => c.exts.includes(ext))
  if (hit) return { category: hit, kind: hit.kind }
  if (CODE_EXTS.includes(ext)) return { category: ASSET_CATEGORIES[1], kind: 'code' }
  return { category: OTHER_CATEGORY, kind: 'other' }
}

/** 媒体产物落入内置库时的归类子目录（D 阶段落库与 B3 video 发布共用） */
export function assetDirForKind(kind: 'image' | 'video' | 'audio'): string {
  return (ASSET_CATEGORIES.find((c) => c.id === kind) ?? OTHER_CATEGORY).dir
}

/** 统一 '/' 分隔符 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 重名防覆盖：追加分秒时间戳（poster.png → poster_093012.png；与 App 同规则） */
export function dedupeName(name: string, now: Date = new Date()): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${base}_${stamp}${ext}`
}

/* ── 命名库（workspace.json libraries 段；清洗口径与 App 的 sanitizeLibraries 一致） ── */

export interface WorkspaceLibrary {
  id: string
  name: string
  /** 工作区内相对路径（POSIX 风格，如 素材库/海报产出） */
  path: string
  isPublic?: boolean
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function sanitizeLibraries(raw: unknown): WorkspaceLibrary[] {
  if (!Array.isArray(raw)) return []
  const out: WorkspaceLibrary[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (!isNonEmptyString(rec.id) || !isNonEmptyString(rec.name) || !isNonEmptyString(rec.path)) continue
    const posix = String(rec.path).replace(/\\/g, '/')
    if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix) || posix.split('/').includes('..')) continue
    out.push({ id: rec.id, name: rec.name, path: posix, ...(rec.isPublic === true ? { isPublic: true } : {}) })
  }
  return out
}

/* ── 标签索引（.huabu/tags.json；清洗与容错规则与 App 的 tagsIndex.ts 一致） ── */

export type TagsIndex = Record<string, string[]>

/** 标签清洗：去 #、去首尾空白、去重、单条限 12 字、最多 8 条 */
export function cleanTags(raw: string[]): string[] {
  return Array.from(new Set(raw.map((t) => t.trim().replace(/^#/, '').slice(0, 12)).filter(Boolean))).slice(0, 8)
}

/* ── 素材条目 ── */

export interface AssetEntry {
  name: string
  /** 工作区相对路径（POSIX） */
  relPath: string
  kind: AssetKindName
  /** 分类 id（code 文件归 doc 分类） */
  category: AssetCategory['id']
  bytes: number
  mtimeMs: number
  tags: string[]
}

export interface AssetLibraryInfo {
  id: string
  name: string
  path: string
  builtin: boolean
  isPublic?: boolean
  files: AssetEntry[]
}

export interface ImportOptions {
  /** 命名库名字或 id；缺省归档进内置库 assets/<分类>/ */
  library?: string
  /** 归档后立即打的标签（走 cleanTags 清洗） */
  tags?: string[]
  /** 单文件上限（默认 512MB；测试用） */
  maxBytes?: number
  now?: Date
}

export interface ImportResult {
  relPath: string
  name: string
  kind: AssetKindName
  category: AssetCategory['id']
  bytes: number
  /** 发生重名改写（name-2 / 时间戳）时为 true */
  duplicate: boolean
  tags: string[]
}

export type ListOptions = {
  kind?: 'image' | 'video' | 'audio' | 'doc' | 'other'
  tag?: string
  /** 名字/路径子串（大小写不敏感） */
  query?: string
  /** 返回条数上限（默认 50，上限 200） */
  limit?: number
}

function within(root: string, target: string): boolean {
  const norm = (p: string) => {
    const trimmed = p.replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
  }
  const base = norm(root)
  const value = norm(target)
  if (value === base) return true
  const sep = process.platform === 'win32' ? '\\' : '/'
  return value.startsWith(`${base}${sep}`)
}

/**
 * 素材域句柄：绑定一个工作区（Project），所有路径先经 Project 的白名单。
 * 归档 = 复制（源文件不动，与 App importToWorkspace 同语义）。
 */
export class Assets {
  readonly project: Project

  constructor(project: Project) {
    this.project = project
  }

  get tagsFile(): string {
    return this.project.resolveWrite(TAGS_FILE_REL)
  }

  /* ── 标签 ── */

  /** 读索引：不存在/损坏回退空索引（标签丢了不挡素材库，与 App 一致）；读前先做崩溃恢复 */
  loadTags(): TagsIndex {
    recoverAtomicBackupSync(this.tagsFile)
    if (!existsSync(this.tagsFile)) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.tagsFile, 'utf8')) as { tags?: unknown }
      if (!parsed || typeof parsed !== 'object' || typeof parsed.tags !== 'object' || !parsed.tags) return {}
      const out: TagsIndex = {}
      for (const [key, value] of Object.entries(parsed.tags as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          const cleaned = value.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          if (cleaned.length > 0) out[key.replace(/\\/g, '/')] = cleaned
        }
      }
      return out
    } catch {
      return {}
    }
  }

  /**
   * 设置单个文件的标签并原子落盘。
   * mode：add = 并集；set = 替换；remove = 差集。空结果 = 删除条目（索引不留空键）。
   * 返回该文件最终的标签列表。
   */
  setTags(relPath: string, rawTags: string[], mode: 'add' | 'set' | 'remove' = 'add'): string[] {
    const key = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    const current = this.loadTags()[key] ?? []
    let next: string[]
    if (mode === 'set') next = rawTags
    else if (mode === 'remove') {
      const drop = new Set(cleanTags(rawTags))
      next = current.filter((t) => !drop.has(t))
    } else next = [...current, ...rawTags]
    const cleaned = cleanTags(next)
    const index = this.loadTags()
    if (cleaned.length === 0) delete index[key]
    else index[key] = cleaned
    atomicWriteSync(
      this.tagsFile,
      JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tags: index }, null, 2),
    )
    return cleaned
  }

  /* ── 归档 ── */

  /** 命名库清单（内置 assets 合成库不在其中；与 App listLibraries 的命名库部分同源） */
  libraries(): WorkspaceLibrary[] {
    return sanitizeLibraries(this.project.readMeta().libraries)
  }

  /**
   * 归档：把工作区内任意可读文件复制进素材库。
   * - 内置库：按文件名分类落 assets/<分类>/（面板只扫分类子目录，落根不可见）。
   * - 命名库：落库映射目录；C2 决策——仅当映射路径在 assets/** 内才可写（不放开 C1 写白名单），
   *   否则给可操作错误（归档进内置库是插件侧唯一稳妥落点）。
   * 重名永不覆盖：name-2 … name-99，序号耗尽退时间戳后缀。
   */
  importAsset(sourceRel: string, options: ImportOptions = {}): ImportResult {
    const source = this.project.resolve(sourceRel)
    if (!existsSync(source)) throw new Error(`源文件不存在：${sourceRel}`)
    const st = statSync(source)
    if (!st.isFile()) throw new Error(`源不是常规文件：${sourceRel}`)
    const maxBytes = options.maxBytes ?? MAX_IMPORT_BYTES
    if (st.size > maxBytes) {
      throw new Error(`文件过大（${st.size} 字节 > ${Math.floor(maxBytes / 1024 / 1024)}MB 上限）：${sourceRel}；请先压缩或裁剪`)
    }
    const name = basename(source)
    const { category, kind } = categorizeFileName(name)

    let destDir: string
    if (options.library) {
      const lib = this.libraries().find((l) => l.name === options.library || l.id === options.library)
      if (!lib) throw new Error(`素材库不存在：${options.library}（可用：${this.libraries().map((l) => l.name).join('、') || '无'}）`)
      const libDir = this.project.resolve(lib.path)
      if (!within(this.project.resolve('assets'), libDir)) {
        throw new Error(
          `命名库「${lib.name}」的目录（${lib.path}）不在 assets/** 写白名单内，插件拒绝写入；` +
            '请不传 library 归档进内置库 assets/<分类>/，或先在 Huabu 应用里把库映射到 assets/ 下',
        )
      }
      destDir = libDir
    } else {
      destDir = this.project.resolveWrite(`${category.dir}/`)
    }

    mkdirSync(destDir, { recursive: true })
    let finalName = name
    let duplicate = false
    if (existsSync(join(destDir, finalName))) {
      duplicate = true
      const dot = name.lastIndexOf('.')
      const base = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      let candidate = ''
      for (let n = 2; n < 100; n += 1) {
        candidate = `${base}-${n}${ext}`
        if (!existsSync(join(destDir, candidate))) break
        candidate = ''
      }
      finalName = candidate || dedupeName(name, options.now)
    }
    const dest = join(destDir, finalName)
    copyFileSync(source, dest)
    const relPath = normalizePath(relative(this.project.root, dest))
    const tags = options.tags?.length ? this.setTags(relPath, options.tags) : []
    return { relPath, name: finalName, kind, category: category.id, bytes: st.size, duplicate, tags }
  }

  /* ── 清单与搜索 ── */

  /**
   * 素材清单：内置合成库（assets/<分类>/ 五个目录的并集）+ 命名库，每库扁平扫描（不递归）。
   * 过滤在条目级做（kind 对分类 id；tag 对标签；query 对名字/路径子串），limit 截总条数。
   */
  list(options: ListOptions = {}): { libraries: AssetLibraryInfo[]; total: number; truncated: boolean } {
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)))
    // 过滤条件与 cleanTags 同口径截断，避免「打了 12 字截断的标签」查不到
    const tagsIndex = this.loadTags()
    this.tagsCache = tagsIndex
    const query = options.query?.trim().toLowerCase()
    const tag = options.tag?.trim().replace(/^#/, '').slice(0, 12)

    const match = (entry: AssetEntry): boolean => {
      if (options.kind && entry.category !== options.kind) return false
      if (tag && !entry.tags.includes(tag)) return false
      if (query && !(entry.name.toLowerCase().includes(query) || entry.relPath.toLowerCase().includes(query))) return false
      return true
    }

    const out: AssetLibraryInfo[] = []
    let total = 0
    let truncated = false

    const emit = (info: AssetLibraryInfo) => {
      const files: AssetEntry[] = []
      for (const entry of info.files) {
        if (total + files.length >= limit) {
          truncated = true
          break
        }
        if (match(entry)) files.push(entry)
      }
      total += files.length
      out.push({ ...info, files })
    }

    const builtinFiles: AssetEntry[] = []
    for (const category of [...ASSET_CATEGORIES, OTHER_CATEGORY]) {
      builtinFiles.push(...this.scanDir(this.project.resolve(category.dir), category.id))
    }
    emit({ id: 'builtin-assets', name: '画布素材', path: 'assets', builtin: true, files: builtinFiles })

    for (const lib of this.libraries()) {
      let libDir: string
      try {
        libDir = this.project.resolve(lib.path)
      } catch {
        continue
      }
      emit({ id: lib.id, name: lib.name, path: lib.path, builtin: false, ...(lib.isPublic ? { isPublic: true } : {}), files: this.scanDir(libDir) })
    }

    return { libraries: out.filter((l) => l.files.length > 0), total, truncated }
  }

  /** 单目录扁平扫描（不递归、跳过点开头、每目录上限 200、按名字排序；tags 从索引合并） */
  private scanDir(absDir: string, category?: AssetCategory['id']): AssetEntry[] {
    if (!existsSync(absDir)) return []
    const out: AssetEntry[] = []
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue
      const abs = join(absDir, entry.name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      const relPath = normalizePath(relative(this.project.root, abs))
      const { kind, category: cat } = categorizeFileName(entry.name)
      out.push({
        name: entry.name,
        relPath,
        kind,
        category: category ?? cat.id,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        tags: this.tagsCache[relPath] ?? [],
      })
      if (out.length >= MAX_LIBRARY_FILES) break
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  /** list() 期间缓存的标签索引（scanDir 扫多目录共用一次读盘，用完即弃） */
  private tagsCache: TagsIndex = {}
}

export class AssetsService {
  readonly version = ASSETS_SERVICE_VERSION

  constructor(private readonly projects: ProjectService = new ProjectService()) {}

  forProject(project: Project): Assets {
    return new Assets(project)
  }

  /** 工具侧入口：先经 workingDirectory.ensure 取会话 cwd，再绑定句柄 */
  async forExec(
    ctx: { workingDirectory?: WorkingDirectoryLike },
    exec: ToolExecLike,
  ): Promise<Assets> {
    const cwd = await resolveSessionCwd(ctx, exec)
    return new Assets(this.projects.open(cwd))
  }
}

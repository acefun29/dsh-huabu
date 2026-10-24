// C3 素材库工具三件套：huabu_asset_list / huabu_asset_import / huabu_asset_tag。
// 参数校验在工具层（可操作错误），路径与数据契约在 huabu.assets 服务层。
import { existsSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import type { Assets, AssetsService, ListOptions } from '../services/assets'
import type { WorkingDirectoryLike } from '../services/session-cwd'

/** DSH execute 的 exec 形状（类型层只有 cwd；运行时 agent/signal 由宿主提供，见 A4/B2 契约） */
export interface AssetToolExecLike {
  cwd?: string
  agent?: unknown
  signal?: AbortSignal
}

export type AssetToolName = 'huabu_asset_list' | 'huabu_asset_import' | 'huabu_asset_tag'

export interface AssetToolContext {
  workingDirectory?: WorkingDirectoryLike
}

export interface AssetToolValue {
  tool: AssetToolName
  ok: boolean
  text: string
}

export interface AssetToolDefLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: Record<string, unknown>, value: AssetToolValue): unknown
  }
  timeoutMs: number
  execute(args: Record<string, unknown>, exec: AssetToolExecLike): Promise<AssetToolValue>
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    ok: { type: 'boolean' },
    text: { type: 'string' },
  },
  required: ['tool', 'ok', 'text'],
}

const KIND_ENUM = ['image', 'doc', 'audio', 'video', 'other'] as const

function textBlocks(_args: Record<string, unknown>, value: AssetToolValue) {
  return [{ type: 'text', text: value.text }]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function formatMtime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** huabu_asset_list：按库分组的素材清单文本 */
export function renderAssetList(listing: ReturnType<Assets['list']>, options: ListOptions): string {
  if (listing.total === 0) {
    const filters = [
      options.kind ? `分类=${options.kind}` : '',
      options.tag ? `标签=${options.tag}` : '',
      options.query ? `关键字=${options.query}` : '',
    ].filter(Boolean)
    return `素材清单：0 个文件${filters.length ? `（过滤条件：${filters.join(' · ')}）` : '（素材库为空）'}。` +
      '上传/生成产物归档后才会出现在清单里（huabu_asset_import）。'
  }
  const lines: string[] = [`素材清单（${listing.libraries.length} 个库 · 共 ${listing.total} 个文件）：`]
  for (const lib of listing.libraries) {
    lines.push(`▸ ${lib.name}${lib.builtin ? '（内置 assets/）' : `（${lib.path}/）`} · ${lib.files.length} 个`)
    for (const file of lib.files) {
      const tags = file.tags.length > 0 ? ` · ${file.tags.map((t) => `#${t}`).join(' ')}` : ''
      lines.push(
        `  ${file.relPath} · ${formatBytes(file.bytes)} · ${formatMtime(file.mtimeMs)}${tags}`,
      )
    }
  }
  if (listing.truncated) lines.push(`（已达 limit 上限，可能还有更多；用 kind/tag/query 收窄）`)
  return lines.join('\n')
}

function parseListArgs(raw: Record<string, unknown>): ListOptions {
  const options: ListOptions = {}
  if (raw.kind !== undefined && raw.kind !== null) {
    if (typeof raw.kind !== 'string' || !(KIND_ENUM as readonly string[]).includes(raw.kind)) {
      throw new Error(`未知 kind：「${String(raw.kind)}」；可用：${KIND_ENUM.join(' / ')}`)
    }
    options.kind = raw.kind as ListOptions['kind']
  }
  for (const field of ['tag', 'query'] as const) {
    const value = raw[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
    if (value.trim()) options[field] = value.trim()
  }
  if (raw.limit !== undefined && raw.limit !== null) {
    if (typeof raw.limit !== 'number' || !Number.isFinite(raw.limit) || raw.limit < 1) {
      throw new Error('limit 必须是 ≥1 的数字（上限 200）')
    }
    options.limit = raw.limit
  }
  return options
}

function parseTagsParam(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${field} 必须是字符串数组`)
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error(`${field} 的每一项必须是字符串`)
    if (item.trim()) out.push(item.trim())
  }
  return out
}

/** 把工具传入的 path 归一成工作区 POSIX 相对键（越界在 project.resolve 处被拒） */
function normalizeRel(assets: Assets, path: string): string {
  const abs = assets.project.resolve(path)
  return relative(assets.project.root, abs).replace(/\\/g, '/')
}

export function assembleAssetTools(ctx: AssetToolContext, service: Pick<AssetsService, 'forExec'>): AssetToolDefLike[] {
  const bind = (exec: AssetToolExecLike) => service.forExec(ctx, exec)

  const list: AssetToolDefLike = {
    name: 'huabu_asset_list',
    description:
      '列出项目素材库的文件清单（内置 assets/ 分类目录 + 命名库，按库分组），返回工作区相对路径、大小、修改时间与标签。' +
      '可用 kind/tag/query/limit 过滤。回答「项目里有哪些图/素材」先调它，不要自己 glob 目录。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...KIND_ENUM], description: '分类过滤：image/doc/audio/video/other' },
        tag: { type: 'string', description: '标签过滤（不带 #）' },
        query: { type: 'string', description: '文件名/路径子串（大小写不敏感）' },
        limit: { type: 'number', description: '返回条数上限，默认 50、最大 200' },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: textBlocks },
    timeoutMs: 10_000,
    async execute(rawArgs, exec) {
      const options = parseListArgs(rawArgs)
      const assets = await bind(exec)
      const listing = assets.list(options)
      const value: AssetToolValue = { tool: 'huabu_asset_list', ok: true, text: renderAssetList(listing, options) }
      return JSON.parse(JSON.stringify(value)) as AssetToolValue
    },
  }

  const importer: AssetToolDefLike = {
    name: 'huabu_asset_import',
    description:
      '把工作区内的文件归档进素材库：复制到 assets/<分类>/（或 assets/ 下的命名库），重名自动加序号，可同时打标签。' +
      'path 必须是工作区相对路径；单文件上限 512MB。生成产物（.huabu/media/ 等）要进素材库也走它。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '源文件的工作区相对路径（复制，不移动原文件）' },
        library: { type: 'string', description: '命名库名字（仅支持映射在 assets/ 内的库；缺省归内置库）' },
        tags: { type: 'array', items: { type: 'string' }, description: '归档时打的标签（自动去 #、单条 ≤12 字、最多 8 个）' },
      },
      required: ['path'],
    },
    output: { schema: OUTPUT_SCHEMA, render: textBlocks },
    timeoutMs: 60_000,
    async execute(rawArgs, exec) {
      const path = typeof rawArgs.path === 'string' ? rawArgs.path.trim() : ''
      if (!path) throw new Error('缺少 path 参数（源文件的工作区相对路径）')
      const library =
        typeof rawArgs.library === 'string' && rawArgs.library.trim() ? rawArgs.library.trim() : undefined
      const tags = rawArgs.tags === undefined ? [] : parseTagsParam(rawArgs.tags, 'tags')

      const assets = await bind(exec)
      const result = assets.importAsset(path, { ...(library ? { library } : {}), ...(tags.length ? { tags } : {}) })
      const label = result.duplicate ? '（源同名文件已在库中，已改名保留两者）' : ''
      const tagText = result.tags.length ? ` · 标签 ${result.tags.map((t) => `#${t}`).join(' ')}` : ''
      const value: AssetToolValue = {
        tool: 'huabu_asset_import',
        ok: true,
        text: `已归档：${result.relPath}（${formatBytes(result.bytes)}${tagText}）${label}；源文件保留在 ${path}。`,
      }
      return JSON.parse(JSON.stringify(value)) as AssetToolValue
    },
  }

  const tag: AssetToolDefLike = {
    name: 'huabu_asset_tag',
    description:
      '给素材文件打/改标签（标签是文件级元数据，存 .huabu/tags.json，供 huabu_asset_list 过滤）。' +
      'mode=add 追加（默认）/ set 替换 / remove 移除；自动去 #、单条 ≤12 字、每文件最多 8 个。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '素材文件的工作区相对路径' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
        mode: { type: 'string', enum: ['add', 'set', 'remove'], description: '默认 add' },
      },
      required: ['path', 'tags'],
    },
    output: { schema: OUTPUT_SCHEMA, render: textBlocks },
    timeoutMs: 10_000,
    async execute(rawArgs, exec) {
      const path = typeof rawArgs.path === 'string' ? rawArgs.path.trim() : ''
      if (!path) throw new Error('缺少 path 参数（素材文件的工作区相对路径）')
      const tags = parseTagsParam(rawArgs.tags, 'tags')
      const mode = rawArgs.mode === undefined || rawArgs.mode === null ? 'add' : rawArgs.mode
      if (mode !== 'add' && mode !== 'set' && mode !== 'remove') {
        throw new Error(`未知 mode：「${String(mode)}」；可用：add / set / remove`)
      }

      const assets = await bind(exec)
      const rel = normalizeRel(assets, path)
      if (!existsSync(assets.project.resolve(rel))) {
        throw new Error(`文件不存在：${rel}（先归档：huabu_asset_import，或检查路径拼写）`)
      }
      statSync(assets.project.resolve(rel))
      const final = assets.setTags(rel, tags, mode)
      const value: AssetToolValue = {
        tool: 'huabu_asset_tag',
        ok: true,
        text:
          final.length === 0
            ? `${rel} 现在没有标签。`
            : `${rel} 的标签：${final.map((t) => `#${t}`).join(' ')}（共 ${final.length} 个）`,
      }
      return JSON.parse(JSON.stringify(value)) as AssetToolValue
    },
  }

  return [list, importer, tag]
}

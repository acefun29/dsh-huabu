// dsh-huabu host 入口。
// A1 骨架 + A4 探针：huabu_probe（带自定义卡）与 huabu_probe_plain（无卡，走 generic card 对照），
// 用于关闭 G4a（loadImage 多图）/ G4b（chrome 边界）/ G4c（generic card 是否渲 image block）。
// 正式服务层 / 工具在阶段 B–F 接入。
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { BlockoutService } from './services/blockout'
import { AssetsService } from './services/assets'
import { DEFAULT_DIGEST_CONFIG, DIGEST_CONTEXT_NAME, DIGEST_CONTEXT_ORDER, ProjectDigest } from './services/digest'
import { MediaService } from './services/media'
import { ProjectService } from './services/project'
import { installAllSkillBundles } from './services/skills'
import { assembleAssetTools } from './tools/assets'
import { assembleBlockoutTool } from './tools/blockout'
import { assembleContextTool } from './tools/context'
import { assembleImageTool } from './tools/image'

export const name = 'huabu'
// attachments 必须在 inject 里声明，否则 ctx.attachments 不可访问
// （A4 实测报错：cannot get property "attachments" without inject）
// workingDirectory 提供会话工作区（B2 契约 #5：exec.cwd 不是会话 cwd）
// systemPrompt 用于 C4 每轮摘要注入（dsh-system-prompt 宿主服务）
export const inject = ['tools', 'commands', 'attachments', 'workingDirectory', 'systemPrompt']

export const Config = z.object({
  installSkills: z.boolean().default(true),
})

/* ── 探针用最小 PNG 生成（纯色 RGB，零依赖） ─────────────── */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: RGB
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0]
    row[2 + x * 3] = rgb[1]
    row[3 + x * 3] = rgb[2]
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const PROBE_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [65, 118, 230], // 品牌蓝
  [63, 167, 116], // 绿
  [230, 149, 63], // 橙
  [158, 63, 230], // 紫
]

/* ── DSH 宿主上下文（tools/attachments 是运行时注入服务，cordis 基础类型不含） ── */
interface DshToolExec {
  cwd?: string
}

interface DshToolDef {
  name: string
  description: string
  parameters?: Record<string, unknown>
  output?: Record<string, unknown>
  timeoutMs?: number
  execute(args: Record<string, unknown>, exec: DshToolExec): Promise<unknown>
}

interface DshHostContext extends Context {
  tools?: { register(def: DshToolDef): unknown }
  attachments?: { saveImage(input: unknown): Promise<unknown> }
  workingDirectory?: { ensure(agent: unknown, signal?: AbortSignal): Promise<string> }
  systemPrompt?: {
    context(entry: {
      name: string
      order: number
      interpolate?: boolean
      text: (context: { agent?: unknown; signal?: AbortSignal }) => string
    }): unknown
  }
}

/* ── 探针执行：写 PNG → 尽量做 attachment ───────────────── */
interface ProbeResult {
  ok: boolean
  label: string
  count: number
  paths: string[]
  attachments: unknown[]
  attachmentError?: string
  execDump?: string
}

async function runProbe(ctx: DshHostContext, exec: unknown, count: number, label: string): Promise<ProbeResult> {
  // A4 契约探测：exec 的真实形状写进结果，供 dump 观察
  const execDump = (() => {
    try {
      return JSON.stringify(exec)?.slice(0, 400)
    } catch {
      return String(exec).slice(0, 400)
    }
  })()
  const execAny = exec as { cwd?: string } | undefined
  const base = execAny?.cwd && path.isAbsolute(execAny.cwd) ? execAny.cwd : process.cwd()
  const dir = path.join(base, '.huabu', 'probe')
  await mkdir(dir, { recursive: true })
  const paths: string[] = []
  const buffers: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const buf = solidPng(96, 96, PROBE_COLORS[i % PROBE_COLORS.length])
    const p = path.join(dir, `probe-${label}-${i}.png`)
    await writeFile(p, buf)
    paths.push(p)
    buffers.push(buf)
  }
  // saveImage 契约（A4 从 dsh-attachment-local 源码核实）：
  // 入参 { data: bytes, mediaType, name? }，返回 { attachmentId, mediaType, width, height, bytes, name? }
  // 注意：execute 的返回值必须可无损 JSON 序列化（INVALID_TOOL_OUTPUT），ref 里可能带非 JSON 字段，只取纯标量。
  const attachments: unknown[] = []
  let attachmentError: string | undefined
  try {
    const save = ctx.attachments?.saveImage
    if (typeof save !== 'function') throw new Error('ctx.attachments.saveImage 不可用')
    for (let i = 0; i < buffers.length; i++) {
      const ref = (await save.call(ctx.attachments, {
        data: buffers[i],
        mediaType: 'image/png',
        name: path.basename(paths[i]),
      })) as Record<string, unknown>
      const plain: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(ref ?? {})) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null) plain[k] = v
      }
      attachments.push(plain)
    }
  } catch (e) {
    attachmentError = e instanceof Error ? e.message : String(e)
  }
  // execute 返回值必须可无损 JSON 往返（INVALID_TOOL_OUTPUT）：undefined 字段也算不无损
  const result: ProbeResult = {
    ok: attachmentError === undefined,
    label,
    count,
    paths,
    attachments,
    ...(attachmentError !== undefined ? { attachmentError } : {}),
    ...(execDump ? { execDump } : {}),
  }
  return JSON.parse(JSON.stringify(result)) as ProbeResult
}

function probeRender(_args: unknown, value: ProbeResult) {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text:
        `[huabu_probe:${value.label}] 生成 ${value.count} 张探针图（96×96 纯色 PNG）。\n` +
        value.paths.map((p) => `- ${p}`).join('\n') +
        (value.attachmentError ? `\nattachment 失败：${value.attachmentError}` : `\nattachment ×${value.attachments.length}`) +
        (value.execDump ? `\nexec=${value.execDump}` : ''),
    },
  ]
  for (const a of value.attachments) blocks.push({ type: 'image', attachment: a })
  return blocks
}

/* ── apply ───────────────────────────────────────────────── */
export function apply(ctx: DshHostContext, config: unknown): void {
  // C1：项目句柄（会话 cwd / workspace.json / 路径白名单），后续素材库与媒体落盘共用
  const project = new ProjectService()
  ctx.provide('huabu.project', project)

  // C2：素材域服务（归档/命名库/标签索引/搜索），落盘走 huabu.project 的白名单
  const assets = new AssetsService(project)
  ctx.provide('huabu.assets', assets)

  // D1：媒体生成服务（移植自主仓库 src/main/media；凭据 = 插件配置明文 Key 或环境变量）
  const mediaKeys = (config as { media?: { apiKeys?: Record<string, string> } } | undefined)?.media?.apiKeys
  const media = new MediaService(project, mediaKeys ? { apiKeys: mediaKeys } : {})
  ctx.provide('huabu.media', media)

  // B2：引擎服务先注册；B3 工具经闭包使用它
  const blockout = new BlockoutService()
  ctx.provide('huabu.blockout', blockout)
  ctx.tools?.register(assembleBlockoutTool(ctx, blockout))

  // C3：素材库三件套 + 上下文工具（服务在 huabu.assets / huabu.project）
  for (const tool of assembleAssetTools(ctx, assets)) ctx.tools?.register(tool)
  ctx.tools?.register(assembleContextTool(ctx, assets))

  // D2：图片生成工具（默认走 mock 供应商，零 Key 可用）
  ctx.tools?.register(assembleImageTool(ctx, media))

  // C4：每轮摘要注入。text 回调必须同步，cwd 经 WeakMap 缓存 + 异步预热（首轮可能为空）
  const digestOptions = (config as {
    injectDigest?: boolean
    digestBudgetTokens?: number
    digestMinIntervalMs?: number
  }) ?? {}
  const digest = new ProjectDigest(project, {
    budgetTokens: Number.isFinite(digestOptions.digestBudgetTokens)
      ? Math.max(50, Math.floor(digestOptions.digestBudgetTokens as number))
      : DEFAULT_DIGEST_CONFIG.budgetTokens,
    minIntervalMs: Number.isFinite(digestOptions.digestMinIntervalMs)
      ? Math.max(0, Math.floor(digestOptions.digestMinIntervalMs as number))
      : DEFAULT_DIGEST_CONFIG.minIntervalMs,
  })
  if (digestOptions.injectDigest !== false && ctx.systemPrompt) {
    ctx.systemPrompt.context({
      name: DIGEST_CONTEXT_NAME,
      order: DIGEST_CONTEXT_ORDER,
      interpolate: false,
      text: (c) => {
        void digest.warm(c?.agent, (agent, signal) => ctx.workingDirectory!.ensure(agent, signal))
        return digest.text(c?.agent)
      },
    })
  }

  // B5/D3：幂等安装技能（$DSH_HOME/skills/huabu-blockout + huabu-media）；失败不阻断插件
  const installSkills = (config as { installSkills?: boolean } | undefined)?.installSkills !== false
  if (installSkills) {
    try {
      for (const skill of installAllSkillBundles()) {
        ctx.logger?.info?.(
          `dsh-huabu skills: ${skill.status === 'installed' ? '安装' : '已是最新'} ${skill.targetDir}（v${skill.version}${skill.copied.length ? `，写入 ${skill.copied.length} 文件` : ''}）`,
        )
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-huabu skills: 安装技能失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  ctx.logger?.info?.(`dsh-huabu applied: huabu.project ${project.version}, huabu.assets ${assets.version}, huabu.media ${media.version}, huabu.blockout ${blockout.version}, huabu_blockout, asset tools + huabu_context (C3), digest (C4), huabu_image_generate (D2), probes (A4)`)

  ctx.tools?.register({
    name: 'huabu_probe',
    description:
      'A4 探针（带自定义卡）：生成 count 张纯色 PNG（默认 4，上限 4），返回文本 + image block，' +
      '并把文件写到 <工作区>/.huabu/probe/。用于验证工具卡多图渲染。无实际业务用途。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '生成张数，1–4，默认 4' },
      },
    },
    output: { schema: { type: 'object' }, render: probeRender },
    timeoutMs: 10_000,
    async execute(args: Record<string, unknown>, exec: DshToolExec) {
      const count = Math.min(4, Math.max(1, Math.floor((args.count as number) ?? 4)))
      return await runProbe(ctx, exec, count, 'main')
    },
  })

  ctx.tools?.register({
    name: 'huabu_probe_plain',
    description:
      'A4 探针（无自定义卡）：固定生成 4 张纯色 PNG 并返回 image block，但不注册 toolview，' +
      '用于观察 generic card 的默认渲染。无实际业务用途。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: probeRender },
    timeoutMs: 10_000,
    async execute(_args: Record<string, unknown>, exec: DshToolExec) {
      return await runProbe(ctx, exec, 4, 'plain')
    },
  })
}
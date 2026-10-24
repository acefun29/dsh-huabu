// C4 每轮摘要注入：systemPrompt.context 的 text 回调必须同步返回，
// 会话 cwd 经 workingDirectory.ensure 是异步的——所以按 agent 缓存 cwd：
// 首次见到 agent 时触发异步预热（本轮为空，下一次 assemble 即有值），
// 之后每轮同步现算摘要。未变化 / 节流窗口内 / 空库 → 返回 ''（不渲染该段）。
import { Assets } from './assets'
import { summarizeAssets, type AssetsSummary } from './context'
import { ProjectService } from './project'

export const DIGEST_CONTEXT_NAME = 'huabu:project-digest'
/** CONTEXT_ORDERS（dsh-system-prompt）没有 Huabu 名额；排在 WEB_SURFACE(210) 之后 */
export const DIGEST_CONTEXT_ORDER = 900

export interface DigestConfig {
  /** 摘要 token 预算（默认 300） */
  budgetTokens: number
  /** 两次注入的最小间隔毫秒（默认 10s） */
  minIntervalMs: number
}

export const DEFAULT_DIGEST_CONFIG: DigestConfig = { budgetTokens: 300, minIntervalMs: 10_000 }

/** 粗略 token 估算：CJK 每字 ~1 token，ASCII ~3 字符/token */
export function estimateTokens(text: string): number {
  let cjk = 0
  let ascii = 0
  for (const ch of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk += 1
    else ascii += 1
  }
  return cjk + Math.ceil(ascii / 3)
}

const CATEGORY_SHORT: Record<string, string> = { image: '图', doc: '文档', audio: '音频', video: '视频', other: '其他' }

/** 从摘要构建短摘要行；超预算先裁「最近」列表，再硬截断 */
export function digestLine(summary: AssetsSummary, budgetTokens: number): string {
  const head =
    `素材库共 ${summary.total} 个文件` +
    `（${Object.entries(summary.counts)
      .map(([id, n]) => `${CATEGORY_SHORT[id] ?? id} ${n}`)
      .join(' / ')}）`

  const build = (recentCount: number) => {
    const names = summary.recent.slice(0, recentCount).map((r) => r.relPath.split('/').pop() ?? r.relPath)
    const recent = names.length > 0 ? `；最近：${names.join('、')}` : ''
    return `【Huabu】${head}${recent}。明细用 huabu_asset_list / huabu_context 查`
  }

  let text = build(summary.recent.length)
  if (estimateTokens(text) <= budgetTokens) return text
  for (const n of [2, 1, 0]) {
    text = build(n)
    if (estimateTokens(text) <= budgetTokens) return text
  }
  // 仍超预算（预算小于头部本身）：按比例迭代收敛，保底 8 个字符
  while (estimateTokens(text) > budgetTokens && text.length > 8) {
    const ratio = budgetTokens / estimateTokens(text)
    text = text.slice(0, Math.max(8, Math.floor(text.length * Math.min(ratio, 0.9))))
  }
  return text
}

export class ProjectDigest {
  private readonly cwdByAgent = new WeakMap<object, string>()
  private lastSignature = ''
  /** 上次实际注入的时间；-Infinity 保证首轮不被节流拦住 */
  private emittedAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly projects: ProjectService = new ProjectService(),
    private readonly config: DigestConfig = DEFAULT_DIGEST_CONFIG,
  ) {}

  /** 已知会话 cwd 时登记（工具路径顺手预热；warm 也走这里） */
  noteAgentCwd(agent: unknown, cwd: string): void {
    if (agent !== null && typeof agent === 'object' && typeof cwd === 'string' && cwd) {
      this.cwdByAgent.set(agent, cwd)
    }
  }

  /** 异步预热：systemPrompt text 回调首次见到 agent 时触发，不阻塞本轮 */
  async warm(agent: unknown, ensure: (agent: unknown, signal?: AbortSignal) => Promise<string>): Promise<void> {
    if (agent === null || typeof agent !== 'object') return
    if (this.cwdByAgent.has(agent)) return
    try {
      this.noteAgentCwd(agent, await ensure(agent))
    } catch {
      /* 会话工作区解析失败：摘要保持静默（''），不打断宿主 */
    }
  }

  /**
   * 每轮求值（同步）。返回 '' 表示本轮不注入该段：
   * 无缓存 cwd / 空库 / 摘要未变化 / 距上次注入不足 minIntervalMs。
   */
  text(agent: unknown, now: number = Date.now()): string {
    const cwd = agent !== null && typeof agent === 'object' ? this.cwdByAgent.get(agent) : undefined
    if (!cwd) return ''
    let summary: AssetsSummary
    try {
      summary = summarizeAssets(new Assets(this.projects.open(cwd)), { recentN: 3, now })
    } catch {
      return ''
    }
    if (summary.total === 0) return ''
    if (summary.signature === this.lastSignature) return ''
    if (now - this.emittedAt < this.config.minIntervalMs) return ''
    this.lastSignature = summary.signature
    this.emittedAt = now
    return digestLine(summary, this.config.budgetTokens)
  }
}
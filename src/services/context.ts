// 上下文摘要构建（C3/C4 共用）：素材清单按分类计数 + 最近条目 + 画布态势。
// C3 的 huabu_context 取全量；C4 的每轮注入取短摘要（≤300 token，未变化为空）。
import type { Assets } from './assets'
import { ASSET_CATEGORIES, OTHER_CATEGORY } from './assets'

const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  [...ASSET_CATEGORIES, OTHER_CATEGORY].map((c) => [c.id, c.label]),
)

export interface AssetsSummary {
  /** 按分类 id 计数（只含有文件的分类） */
  counts: Record<string, number>
  total: number
  /** 最近更新的 N 条（mtime 降序） */
  recent: Array<{ relPath: string; mtimeMs: number; tags: string[] }>
  /** 摘要文本（huabu_context 与每轮注入共用同一口径） */
  text: string
  /** 参与摘要的状态签名（counts + recent mtime）；C4 用它判「未变化」 */
  signature: string
}

function formatTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 素材态势摘要。recentN 控制列出的最近条目数（默认 5；注入摘要用 3）。
 * 素材库为空时 text 明确说「空」，模型不用再调 huabu_asset_list 确认。
 */
export function summarizeAssets(assets: Assets, options: { recentN?: number; now?: number } = {}): AssetsSummary {
  const recentN = Math.max(0, options.recentN ?? 5)
  const now = options.now ?? Date.now()
  const listing = assets.list({ limit: 200 })

  const counts: Record<string, number> = {}
  for (const lib of listing.libraries) {
    for (const file of lib.files) {
      counts[file.category] = (counts[file.category] ?? 0) + 1
    }
  }
  const recent = listing.libraries
    .flatMap((lib) => lib.files)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, recentN)
    .map((f) => ({ relPath: f.relPath, mtimeMs: f.mtimeMs, tags: f.tags }))

  const partsCount =
    listing.total === 0
      ? '素材库为空（还没有归档文件）'
      : Object.entries(counts)
          .map(([id, n]) => `${CATEGORY_LABELS[id] ?? id} ${n}`)
          .join(' · ')

  const lines: string[] = [
    `素材库（共 ${listing.total} 个文件${listing.truncated ? '，清单截断到前 200 条' : ''}）：${partsCount}`,
  ]
  if (recent.length > 0) {
    lines.push(
      `最近：${recent.map((r) => `${r.relPath}（${formatTime(r.mtimeMs, now)}${r.tags.length ? ` · ${r.tags.join('/')}` : ''}）`).join('、')}`,
    )
  }

  const signature = JSON.stringify([
    counts,
    recent.map((r) => [r.relPath, Math.floor(r.mtimeMs / 1000)]),
  ])

  return { counts, total: listing.total, recent, text: lines.join('\n'), signature }
}

/** 画布态势：v0.1 无画布 UI，恒定输出未启用说明 */
export function boardSummary(): string {
  return '画布：未启用（Huabu 画布 UI 属 v0.2；当前以素材库 + blockout 产物目录为准）'
}

/** 媒体任务态势（E3）：按状态计数 + 重启中断/失败任务点名（对账可见性） */
export function mediaJobsSummary(jobs: Array<{ kind: string; state: string; error?: string; jobId: string }>): string {
  if (jobs.length === 0) return '生成任务：无'
  const byState = new Map<string, number>()
  for (const job of jobs) byState.set(job.state, (byState.get(job.state) ?? 0) + 1)
  const counts = [...byState.entries()].map(([state, n]) => `${state} ${n}`).join(' / ')
  const interrupted = jobs
    .filter((job) => job.state === 'failed' && (job.error ?? '').includes('中断'))
    .slice(-3)
    .map((job) => job.jobId.slice(0, 8))
  return `生成任务：共 ${jobs.length} 条（${counts}）${interrupted.length ? `；重启中断：${interrupted.join('、')}（如需继续请重新提交）` : ''}`
}

/** huabu_context 的全量文本（E3 起含媒体任务态势） */
export function contextText(
  assets: Assets,
  scope: 'assets' | 'board' | 'all' = 'all',
  jobs: Array<{ kind: string; state: string; error?: string; jobId: string }> = [],
): string {
  const lines: string[] = []
  if (scope === 'assets' || scope === 'all') lines.push(summarizeAssets(assets).text)
  if (scope === 'board' || scope === 'all') lines.push(boardSummary())
  if ((scope === 'all' || scope === 'assets') && jobs.length > 0) lines.push(mediaJobsSummary(jobs))
  return lines.join('\n')
}